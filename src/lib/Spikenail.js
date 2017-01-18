const debug = require('debug')('spikenail:Spikenail');

import Koa from 'koa';
import convert from 'koa-convert';
import graphqlHTTP from 'koa-graphql';
import koaRouter from 'koa-router';
import cors from 'koa-cors';

import mongoose from 'mongoose';
import dataloadersMiddleware from './middlewares/dataloaders';
import authMiddleware from './middlewares/auth';

import pluralize from 'pluralize';
import capitalize from 'lodash.capitalize';

import { EventEmitter } from 'events';

import requireAll from 'require-all';

import {
  GraphQLObjectType,
  GraphQLList,
  GraphQLString,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLFloat,
  GraphQLID,
  GraphQLSchema,
  GraphQLNonNull,
  getNullableType
} from 'graphql';

import GraphQLJSON from 'graphql-type-json';

import {
  connectionArgs,
  connectionDefinitions,
  connectionFromArray,
  cursorForObjectInConnection,
  fromGlobalId,
  globalIdField,
  mutationWithClientMutationId,
  nodeDefinitions,
  toGlobalId,
} from 'graphql-relay';

import MutationError from './types/MutationError';
import PageInfo from './types/PageInfo';

/**
 * Spikenail server
 */
class Spikenail extends EventEmitter {

  /**
   * @constructor
   */
  constructor(config) {
    super();

    // Remove memory-leak warning about max listeners.
    this.setMaxListeners(0);
  }

  /**
   * Start the server
   */
  async start() {
    debug('Starting the server');
    try {
      const app = new Koa();
      let router = koaRouter();

      // Load models
      this.models = await this.loadModels();

      // Generate and expose graphql schema
      if (Object.keys(this.models).length) {
        this.graphqlSchema = this.createGraphqlSchema(this.models);

        // Set default graphql route
        router.all('/graphql', convert(graphqlHTTP({
          schema: this.graphqlSchema,
          graphiql: true
        })));
      } else {
        debug('No models loaded');
      }

      app
        .use(convert(cors()))
        .use(authMiddleware())
        .use(dataloadersMiddleware())
        .use(router.routes());

      this.app = app;

      await this.boot();

      this.app.listen(5000, (err) => {
        if (err) {
          throw err;
        }
        console.log('Server is listening on port 5000');
      });
    } catch (err) {
      console.error(err);
    }
  }

  /**
   * Load models
   *
   * @returns {{}}
   */
  loadModels() {
    const appDir = process.cwd();
    debug('loadModels');

    let models = requireAll({
      dirname: appDir + '/models'
    });

    let modelsMap = {};
    for (let className of Object.keys(models)) {

      if (!models[className].default) {
        continue;
      }

      modelsMap[models[className].default.getName()] = models[className].default;
    }

    return modelsMap;
  }

  /**
   * Bootstrap the application
   */
  async boot() {
    const appDir = process.cwd();
    debug('Booting the app', appDir);

    // Boot data sources
    let sources;
    try {
        sources = require(appDir + '/config/sources.js');
        await this.bootDataSources(sources);
    } catch (e) {
      if (e instanceof Error && e.code === "MODULE_NOT_FOUND") {
          debug('Can not load config/sources.js')
      } else {
        console.error(e);
        throw e;
      }
    }
  }

  /**
   * Boot data sources
   *
   * @param sources
   */
  bootDataSources(sources) {
    // TODO remove double default
    console.log('Boot data sources:', sources, sources.default.default.connectionString);
    // TODO: only one data source is currently supported
    return mongoose.connect(sources.default.default.connectionString, { server: { socketOptions: { keepAlive: 1 } } });
  }

  /**
   * Creates root query from models
   * TODO: move all graphql functions into another module
   *
   * @param models
   */
  createGraphqlSchema(models) {
    debug('createGraphqlSchema');

    let fields = {};

    let modelTypes = {};
    let modelFields = {};

    //modelTypes['pageInfo'] = PageInfo;

    // Relay node field support
    const {nodeInterface, nodeField} = nodeDefinitions(
      (globalId, ctx) => {
        let {type, id} = fromGlobalId(globalId);

        debug('nodeInterface - globalId', type, id, ctx);

        let dataLoader = ctx.state.dataLoaders[type];
        if (!dataLoader) {
          return null;
        }

        return dataLoader.load(id);
      },
      (obj) => {
        debug('nodeField - obj - constructor', obj.constructor.modelName);
        return modelTypes[obj.constructor.modelName] || null;
      }
    );

    // Root query
    let queryFields = {
      node: nodeField
    };

    // Preparing model types
    // The way to resolve circular references in graphql
    // Determine viewer model if exists
    let viewerModel;
    for (const className of Object.keys(models)) {
      debug('preparing model:', className);

      let model = models[className];

      // Ignore empty model files
      if (!model.getName) {
        continue;
      }

      // Lets determine viewer model
      // TODO: not sure if we actually need a flag for it. It is easier to always use model named User as viewer
      if (model.isViewer()) {
        debug('Viewer model found');
        viewerModel = model;
      }

      let name = model.getName();

      debug('prepate graphql type for model', className);

      // Create placeholder for fields
      modelFields[name] = {};

      modelTypes[name] = new GraphQLObjectType({
        name: name,
        fields: function() {
          return modelFields[name];
        },
        interfaces: [nodeInterface]
      });
    }

    let viewerFields = {
      id: globalIdField('user')
    };

    // Add id and current user fields if User model exists
    if (viewerModel) {
      //viewerFields.id = globalIdField('user');
      viewerFields.user = {
        type: modelTypes.user,
        resolve: function(_, args) {
          return viewerModel.resolveViewer({}, ...arguments);
        }
      }
    }

    // Now fill modelFields and viewer fields
    for (const className of Object.keys(models)) {
      debug('filling graphql type fields for:', className);

      let model = models[className];

      // Ignore empty model files
      if (!model.getName) {
        continue;
      }

      let name = model.getName();

      modelFields[name] = this.schemaToGraphqlFields(model.schema, modelTypes);

      let graphqlType = modelTypes[model.getName()];

      viewerFields['all' + capitalize(pluralize(model.getName()))] = this.wrapTypeIntoConnection(graphqlType, 'viewer');

      queryFields['get' + capitalize(model.getName())] = {
        type: graphqlType,
        args: model.getGraphqlItemArgs(),
        resolve: (function(_, args) {
          let params = {};

          if (args.id) {
            params.id = fromGlobalId(args.id).id;
          }

          return model.resolveItem(params, ...arguments);
        }).bind(this)
      };
    }

    debug('modelTypes', modelTypes);

    let viewer;
    if (Object.keys(viewerFields).length) {
      viewer = {
        type: new GraphQLObjectType({
          name: 'viewer',
          fields: function() { return viewerFields },
          interfaces: [nodeInterface]
        }),
        resolve: function(_, args) {
          return {};
          //return viewerModel.resolveViewer({}, ...arguments);
        }
      };
    }

    // Create mutations
    let mutationFields = {};
    for (const className of Object.keys(models)) {
      debug('Loading model:', className);

      let model = models[className];

      // Ignore empty model files
      if (!model.getName) {
        continue;
      }

      // Mutations
      mutationFields = Object.assign(
        mutationFields,
        this.buildCRUDMutation('create', model, modelTypes, viewer),
        this.buildCRUDMutation('update', model, modelTypes, viewer),
        this.buildCRUDMutation('remove', model, modelTypes, viewer)
      );
    }

    // Lets create and add mutation
    let RootMutation = new GraphQLObjectType({
      name: 'Mutation',
      fields: mutationFields
    });


    // Add viewer if defined
    if (viewer) {
      // TODO: viewer should extend node field
      queryFields.viewer = viewer;
    } else {
      debug('no viewer defined');
    }

    let RootQuery = new GraphQLObjectType({
      name: 'Query',
      fields: () => (queryFields)
    });

    debug('RootQuery schema created');

    let finalSchema = new GraphQLSchema({
      query: RootQuery,
      mutation: RootMutation
    });

    debug('Final schema created');

    return finalSchema;
  }

  /**
   * Build CRUD mutation
   *
   * @param action
   * @param model
   * @param types
   * @param viewer May not exists
   * @returns {{}}
   */
  buildCRUDMutation(action, model, types, viewer) {
    debug('buildMutation', action);
    const mutationName = action + capitalize(model.getName());
    let mutationFields = this.schemaToMutationFields(model.schema);

    // TODO: use or primary flag or restrict such fields through acl
    if (action == 'create') {
      delete mutationFields['id'];
    }

    // TODO: removing userId from input fields as you can not change it
    // TODO: Otherwise we need to make that field nullable or it will throw an error
    //delete mutationFields['userId'];

    // Resolvers
    let successResolver;
    if (action == 'create' || action == 'update') {
      successResolver = function({ result }) {
        // TODO: probably
        if (!result || !result.id) {
          return null;
        }

        debug('createMutation - outputFields resolve', result.id);

        // TODO: handle no id case
        return model.resolveOne({ id: result.id }, ...arguments);
      }
    }

    let config = {
      name: capitalize(mutationName),
      inputFields: mutationFields,

      outputFields: {
        //viewer: viewer,
        errors: {
          type: new GraphQLList(MutationError),
          resolve: function({ errors }) {
            if (errors && errors.length) {
              return errors;
            }

            return null;
          }
        },
        [model.getName()]: {
          type: types[model.getName()],
          resolve: successResolver
        }
      },
      mutateAndGetPayload: function(input) {
        return model[`mutateAndGetPayload${capitalize(action)}`]({}, ...arguments)
      }
    };

    if (viewer) {
      config.outputFields.viewer = viewer;
    }

    if (action == 'remove') {
      config.outputFields.removedId = {
        type: GraphQLString,
        resolve: ({ result }) => {
          return result.id;
        }
      };

      // TODO: not sure
      delete config.outputFields[model.getName()];
    }

    let mutation = mutationWithClientMutationId(config);

    return {
      [mutationName]: mutation
    }
  }

  /**
   * Wrap type into relay connection
   *
   * @param type
   * @param parentName
   * @param resolve
   * @returns {{type, args: ({first, last, after, before, filter}|*), resolve: (function(this:Spikenail))}}
   */
  wrapTypeIntoConnection(type, parentName, resolve) {
    let name = type.name;
    debug('wrapTypeIntoConnection', name);
    // Relay (edges behaviour)
    let Edge = new GraphQLObjectType({
      name: parentName + '_' + name + 'Edge',
      fields: function() {
        return {
          cursor: {
            type: new GraphQLNonNull(GraphQLString)
          },
          node: {
            type: type
          }
        }
      }
    });

    return {
      type: new GraphQLObjectType({
        // We adding schema.name to avoid same conection from two different models
        name: parentName + '_' + name + 'Connection',
        fields: function () {
          return {
            edges: {
              type: new GraphQLList(Edge)
            },
            pageInfo: {
              type: PageInfo
            }
          }
        }
      }),
      args: this.models[name].getGraphqlListArgs(),
      resolve: (function(_, args) {
        return this.models[name].resolveAll({
          //property: field
        }, ...arguments);
      }).bind(this)
    };
  }

  /**
   * Converts model schema to graphql type's fields
   *
   * @private
   *
   * @param schema
   * @param types Other available types
   */
  schemaToGraphqlFields(schema, types) {
    debug('schemaToGraphqlType' ,schema);

    // TODO: support auto createdat, updatedat

    let fields = {};

    for (let prop of Object.keys(schema.properties)) {
      let field = schema.properties[prop];

      debug('field', field);

      // Handle relation
      if (field.relation) {
        debug('createGraphqlType, handle relation', field);

        let type = types[field.ref];

        // Non relay behaviour
        // TODO: ability to select behaviour
        //if (field.relation == 'hasMany') {
        //  type = new GraphQLList(type);
        //}

        if (field.relation == 'hasMany') {

          debug('hasMany');

          // Relay (edges behaviour)
          let Edge = new GraphQLObjectType({
            // We adding schema.name to avoid same conection from two different models
            name: schema.name + '_' + prop + 'Edge',
            fields: function() {
              return {
                cursor: {
                  type: new GraphQLNonNull(GraphQLString)
                },
                node: {
                  type: type
                }
              }
            }
          });

          fields[prop] = {
            type: new GraphQLObjectType({
              // We adding schema.name to avoid same conection from two different models
              name: schema.name + '_' + prop + 'Connection',
              fields: function () {
                return {
                  edges: {
                    type: new GraphQLList(Edge)
                  },
                  pageInfo: {
                    type: PageInfo
                  }
                }
              }
            }),
            args: this.models[field.ref].getGraphqlListArgs(),
            resolve: (function(_, args) {
              return this.models[field.ref].resolveHasMany({
                property: field
              }, ...arguments);
            }).bind(this)
          };
        }

        continue;
      }

      fields[prop] = this.fieldToGraphqlType(prop, field, schema);

      // Add custom resolver if defined
      if (schema.resolvers && schema.resolvers[prop]) {
        fields[prop].resolve = schema.resolvers[prop].bind(this);
      }
    }

    return fields;
  }

  /**
   * TODO: its is very similar to schema to graphql fields
   */
  schemaToMutationFields(schema) {
    let fields = {};

    for (let prop of Object.keys(schema.properties)) {
      let field = schema.properties[prop];
      debug('field', field);

      // Skip relations for now
      if (field.relation) {
        continue;
      }

      fields[prop] = this.fieldToGraphqlType(prop, field, schema);

      // Just strip all not null for now
      // TODO: quickfix ? don't
      fields[prop].type = getNullableType(fields[prop].type);
      debug('Nullable type', fields[prop]);
    }

    return fields;
  }

  /**
   * Check if field is primary key
   *
   * @param field
   * @param name
   * @returns {boolean}
   */
  isPrimaryKey(field, name) {
    return name === 'id';
    // TODO: add keys configuration
  }

  /**
   * Convert type to graphql type
   *
   * @param prop
   * @param field
   * @param schema
   * @returns {*}
   */
  fieldToGraphqlType(prop, field, schema) {
    let type = field.type;

    debug('fieldToGraphqlType', prop, field, schema);

    switch(type) {
      case 'id':
        if (field.foreignKeyFor) {
          return globalIdField(field.foreignKeyFor, function(obj) { return obj[prop] });
        }

        // TODO: workaround
        if (schema.name == 'viewer') {
          return globalIdField('user');
        }

        return globalIdField(schema.name);
      case String:
        return { type: GraphQLString };
      case Boolean:
        return { type: GraphQLBoolean };
      case Number:
        return { type: GraphQLInt }; // TODO: there is two separate types in graphql
      case 'Float':
        return { type: GraphQLFloat };
      case Object:
        return { type: GraphQLJSON };
      // TODO: not sure
      case Array:
        return { type: GraphQLJSON };

      default:
        return { type: GraphQLString };
    }

  }
}

export default new Spikenail();