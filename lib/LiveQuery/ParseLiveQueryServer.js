"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ParseLiveQueryServer = void 0;

var _tv = _interopRequireDefault(require("tv4"));

var _node = _interopRequireDefault(require("parse/node"));

var _Subscription = require("./Subscription");

var _Client = require("./Client");

var _ParseWebSocketServer = require("./ParseWebSocketServer");

var _logger = _interopRequireDefault(require("../logger"));

var _RequestSchema = _interopRequireDefault(require("./RequestSchema"));

var _QueryTools = require("./QueryTools");

var _ParsePubSub = require("./ParsePubSub");

var _SchemaController = _interopRequireDefault(require("../Controllers/SchemaController"));

var _lodash = _interopRequireDefault(require("lodash"));

var _uuid = _interopRequireDefault(require("uuid"));

var _triggers = require("../triggers");

var _Auth = require("../Auth");

var _Controllers = require("../Controllers");

var _lruCache = _interopRequireDefault(require("lru-cache"));

var _UsersRouter = _interopRequireDefault(require("../Routers/UsersRouter"));

var _AdapterLoader = require("../Adapters/AdapterLoader");

var _InMemoryCacheAdapter = require("../Adapters/Cache/InMemoryCacheAdapter");

var _CacheController = require("../Controllers/CacheController");

var _RedisCacheAdapter = _interopRequireDefault(require("../Adapters/Cache/RedisCacheAdapter"));

var _SessionTokenCache = require("./SessionTokenCache");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function getAllRolesNamesForRoleIds(roleIDs, names, queriedRoles) {
  const ins = roleIDs.filter(roleId => {
    return queriedRoles[roleId] !== true;
  }).map(roleId => {
    queriedRoles[roleId] = true;
    const role = new _node.default.Role();
    role.id = roleId;
    return role;
  });

  if (ins.length === 0) {
    return Promise.resolve([...names]);
  }

  const query = new _node.default.Query(_node.default.Role);
  query.containedIn('roles', ins);
  query.limit(10000);
  return query.find({
    useMasterKey: true
  }).then(roles => {
    if (!roles.length) {
      return Promise.resolve(names);
    }

    const ids = [];
    roles.map(role => {
      names.push(role.getName());
      ids.push(role.id);
      queriedRoles[role.id] = queriedRoles[role.id] || false;
    });
    return getAllRolesNamesForRoleIds(ids, names, queriedRoles);
  }).then(names => {
    return Promise.resolve([...names]);
  });
}

function defaultLoadRolesDelegate(auth) {
  return auth.getUserRoles();
}

class ParseLiveQueryServer {
  // className -> (queryHash -> subscription)
  // The subscriber we use to get object update from publisher
  constructor(server, config = {}) {
    this.server = server;
    this.clients = new Map();
    this.subscriptions = new Map();
    config.appId = config.appId || _node.default.applicationId;
    config.masterKey = config.masterKey || _node.default.masterKey; // Store keys, convert obj to map

    const keyPairs = config.keyPairs || {};
    this.keyPairs = new Map();

    for (const key of Object.keys(keyPairs)) {
      this.keyPairs.set(key, keyPairs[key]);
    }

    _logger.default.verbose('Support key pairs', this.keyPairs); // Initialize Parse


    _node.default.Object.disableSingleInstance();

    const serverURL = config.serverURL || _node.default.serverURL;
    _node.default.serverURL = serverURL;

    _node.default.initialize(config.appId, _node.default.javaScriptKey, config.masterKey); // The cache controller is a proper cache controller
    // with access to User and Roles


    this.cacheController = (0, _Controllers.getCacheController)(config); // Initialize cache

    if (config.cacheAdapter instanceof _RedisCacheAdapter.default) {
      const cacheControllerAdapter = (0, _AdapterLoader.loadAdapter)(config.cacheAdapter, _InMemoryCacheAdapter.InMemoryCacheAdapter, {
        appId: config.appId
      });
      this.cacheController = new _CacheController.CacheController(cacheControllerAdapter, config.appId);
    } // This auth cache stores the promises for each auth resolution.
    // The main benefit is to be able to reuse the same user / session token resolution.


    this.authCache = new _lruCache.default({
      max: 500,
      // 500 concurrent
      maxAge: 60 * 60 * 1000 // 1h

    }); // Initialize websocket server

    this.parseWebSocketServer = new _ParseWebSocketServer.ParseWebSocketServer(server, parseWebsocket => this._onConnect(parseWebsocket), config.websocketTimeout); // Initialize subscriber

    this.subscriber = _ParsePubSub.ParsePubSub.createSubscriber(config);
    this.subscriber.subscribe(_node.default.applicationId + 'afterSave');
    this.subscriber.subscribe(_node.default.applicationId + 'afterDelete'); // Register message handler for subscriber. When publisher get messages, it will publish message
    // to the subscribers and the handler will be called.

    this.subscriber.on('message', (channel, messageStr) => {
      _logger.default.verbose('Subscribe messsage %j', messageStr);

      let message;

      try {
        message = JSON.parse(messageStr);
      } catch (e) {
        _logger.default.error('unable to parse message', messageStr, e);

        return;
      }

      this._inflateParseObject(message);

      if (channel === _node.default.applicationId + 'afterSave') {
        this._onAfterSave(message);
      } else if (channel === _node.default.applicationId + 'afterDelete') {
        this._onAfterDelete(message);
      } else {
        _logger.default.error('Get message %s from unknown channel %j', message, channel);
      }
    }); // Initialize sessionToken cache

    this.sessionTokenCache = new _SessionTokenCache.SessionTokenCache(config.cacheTimeout); // hook up queryMiddleware

    this.queryMiddleware = config.queryMiddleware || [];
    this.loadRolesDelegate = config.loadRolesDelegate || defaultLoadRolesDelegate;
    console.log('ParseLiveQueryServer - this.loadRolesDelegate:', this.loadRolesDelegate);
  } // Message is the JSON object from publisher. Message.currentParseObject is the ParseObject JSON after changes.
  // Message.originalParseObject is the original ParseObject JSON.


  _inflateParseObject(message) {
    // Inflate merged object
    const currentParseObject = message.currentParseObject;

    _UsersRouter.default.removeHiddenProperties(currentParseObject);

    let className = currentParseObject.className;
    let parseObject = new _node.default.Object(className);

    parseObject._finishFetch(currentParseObject);

    message.currentParseObject = parseObject; // Inflate original object

    const originalParseObject = message.originalParseObject;

    if (originalParseObject) {
      _UsersRouter.default.removeHiddenProperties(originalParseObject);

      className = originalParseObject.className;
      parseObject = new _node.default.Object(className);

      parseObject._finishFetch(originalParseObject);

      message.originalParseObject = parseObject;
    }
  } // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.


  _onAfterDelete(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterDelete is triggered');

    const deletedParseObject = message.currentParseObject.toJSON();
    const classLevelPermissions = message.classLevelPermissions;
    const className = deletedParseObject.className;

    _logger.default.verbose('ClassName: %j | ObjectId: %s', className, deletedParseObject.id);

    _logger.default.verbose('Current client number : %d', this.clients.size);

    const classSubscriptions = this.subscriptions.get(className);

    if (typeof classSubscriptions === 'undefined') {
      _logger.default.debug('Can not find subscriptions under this class ' + className);

      return;
    }

    for (const subscription of classSubscriptions.values()) {
      const isSubscriptionMatched = this._matchesSubscription(deletedParseObject, subscription);

      if (!isSubscriptionMatched) {
        continue;
      }

      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);

        if (typeof client === 'undefined') {
          continue;
        }

        for (const requestId of requestIds) {
          const acl = message.currentParseObject.getACL(); // Check CLP

          const op = this._getCLPOperation(subscription.query);

          this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op).then(() => {
            // Check ACL
            return this._matchesACL(acl, client, requestId);
          }).then(isMatched => {
            if (!isMatched) {
              return null;
            }

            client.pushDelete(requestId, deletedParseObject);
          }).catch(error => {
            _logger.default.error('Matching ACL error : ', error);
          });
        }
      }
    }
  } // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.


  _onAfterSave(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterSave is triggered');

    let originalParseObject = null;

    if (message.originalParseObject) {
      originalParseObject = message.originalParseObject.toJSON();
    }

    const classLevelPermissions = message.classLevelPermissions;
    const currentParseObject = message.currentParseObject.toJSON();
    const className = currentParseObject.className;

    _logger.default.verbose('ClassName: %s | ObjectId: %s', className, currentParseObject.id);

    _logger.default.verbose('Current client number : %d', this.clients.size);

    const classSubscriptions = this.subscriptions.get(className);

    if (typeof classSubscriptions === 'undefined') {
      _logger.default.debug('Can not find subscriptions under this class ' + className);

      return;
    }

    for (const subscription of classSubscriptions.values()) {
      const isOriginalSubscriptionMatched = this._matchesSubscription(originalParseObject, subscription);

      const isCurrentSubscriptionMatched = this._matchesSubscription(currentParseObject, subscription);

      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);

        if (typeof client === 'undefined') {
          continue;
        }

        for (const requestId of requestIds) {
          // Set orignal ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL
          let originalACLCheckingPromise;

          if (!isOriginalSubscriptionMatched) {
            originalACLCheckingPromise = Promise.resolve(false);
          } else {
            let originalACL;

            if (message.originalParseObject) {
              originalACL = message.originalParseObject.getACL();
            }

            originalACLCheckingPromise = this._matchesACL(originalACL, client, requestId);
          } // Set current ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL


          let currentACLCheckingPromise;

          if (!isCurrentSubscriptionMatched) {
            currentACLCheckingPromise = Promise.resolve(false);
          } else {
            const currentACL = message.currentParseObject.getACL();
            currentACLCheckingPromise = this._matchesACL(currentACL, client, requestId);
          }

          const op = this._getCLPOperation(subscription.query);

          this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op).then(() => {
            return Promise.all([originalACLCheckingPromise, currentACLCheckingPromise]);
          }).then(([isOriginalMatched, isCurrentMatched]) => {
            _logger.default.verbose('Original %j | Current %j | Match: %s, %s, %s, %s | Query: %s', originalParseObject, currentParseObject, isOriginalSubscriptionMatched, isCurrentSubscriptionMatched, isOriginalMatched, isCurrentMatched, subscription.hash); // Decide event type


            let type;

            if (isOriginalMatched && isCurrentMatched) {
              type = 'Update';
            } else if (isOriginalMatched && !isCurrentMatched) {
              type = 'Leave';
            } else if (!isOriginalMatched && isCurrentMatched) {
              if (originalParseObject) {
                type = 'Enter';
              } else {
                type = 'Create';
              }
            } else {
              return null;
            }

            const functionName = 'push' + type;
            const ssToken = client.getSubscriptionInfo(requestId).sessionToken;
            this.sessionTokenCache.getUserId(ssToken).then(userId => {
              return this.cacheController.role.get(ssToken).then(cUser => {
                if (cUser) return cUser;
                return new _node.default.Query(_node.default.User).equalTo("objectId", userId).limit(10000).find({
                  useMasterKey: true
                }).then(user => {
                  if (!user || !user.length) return undefined;
                  this.cacheController.role.put(ssToken, user[0]);
                  return JSON.parse(JSON.stringify(user[0]));
                });
              });
            }).then(user => {
              let result = currentParseObject;
              (this.queryMiddleware || []).forEach(ware => result = ware(result.className, [result], {
                user: {
                  getTeams: () => user.teams
                }
              })[0]);
              client[functionName](requestId, result);
            });
          }, error => {
            _logger.default.error('Matching ACL error : ', error);
          });
        }
      }
    }
  }

  _onConnect(parseWebsocket) {
    parseWebsocket.on('message', request => {
      if (typeof request === 'string') {
        try {
          request = JSON.parse(request);
        } catch (e) {
          _logger.default.error('unable to parse request', request, e);

          return;
        }
      }

      _logger.default.verbose('Request: %j', request); // Check whether this request is a valid request, return error directly if not


      if (!_tv.default.validate(request, _RequestSchema.default['general']) || !_tv.default.validate(request, _RequestSchema.default[request.op])) {
        _Client.Client.pushError(parseWebsocket, 1, _tv.default.error.message);

        _logger.default.error('Connect message error %s', _tv.default.error.message);

        return;
      }

      switch (request.op) {
        case 'connect':
          this._handleConnect(parseWebsocket, request);

          break;

        case 'subscribe':
          this._handleSubscribe(parseWebsocket, request);

          break;

        case 'update':
          this._handleUpdateSubscription(parseWebsocket, request);

          break;

        case 'unsubscribe':
          this._handleUnsubscribe(parseWebsocket, request);

          break;

        default:
          _Client.Client.pushError(parseWebsocket, 3, 'Get unknown operation');

          _logger.default.error('Get unknown operation', request.op);

      }
    });
    parseWebsocket.on('disconnect', () => {
      _logger.default.info(`Client disconnect: ${parseWebsocket.clientId}`);

      const clientId = parseWebsocket.clientId;

      if (!this.clients.has(clientId)) {
        (0, _triggers.runLiveQueryEventHandlers)({
          event: 'ws_disconnect_error',
          clients: this.clients.size,
          subscriptions: this.subscriptions.size,
          error: `Unable to find client ${clientId}`
        });

        _logger.default.error(`Can not find client ${clientId} on disconnect`);

        return;
      } // Delete client


      const client = this.clients.get(clientId);
      this.clients.delete(clientId); // Delete client from subscriptions

      for (const [requestId, subscriptionInfo] of _lodash.default.entries(client.subscriptionInfos)) {
        const subscription = subscriptionInfo.subscription;
        subscription.deleteClientSubscription(clientId, requestId); // If there is no client which is subscribing this subscription, remove it from subscriptions

        const classSubscriptions = this.subscriptions.get(subscription.className);

        if (!subscription.hasSubscribingClient()) {
          classSubscriptions.delete(subscription.hash);
        } // If there is no subscriptions under this class, remove it from subscriptions


        if (classSubscriptions.size === 0) {
          this.subscriptions.delete(subscription.className);
        }
      }

      _logger.default.verbose('Current clients %d', this.clients.size);

      _logger.default.verbose('Current subscriptions %d', this.subscriptions.size);

      (0, _triggers.runLiveQueryEventHandlers)({
        event: 'ws_disconnect',
        clients: this.clients.size,
        subscriptions: this.subscriptions.size
      });
    });
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'ws_connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _matchesSubscription(parseObject, subscription) {
    // Object is undefined or null, not match
    if (!parseObject) {
      return false;
    }

    return (0, _QueryTools.matchesQuery)(parseObject, subscription.query);
  }

  getAuthForSessionToken(sessionToken) {
    if (!sessionToken) {
      return Promise.resolve({});
    }

    const fromCache = this.authCache.get(sessionToken);

    if (fromCache) {
      return fromCache;
    }

    const authPromise = (0, _Auth.getAuthForSessionToken)({
      cacheController: this.cacheController,
      sessionToken: sessionToken
    }).then(auth => {
      return {
        auth,
        userId: auth && auth.user && auth.user.id
      };
    }).catch(error => {
      // There was an error with the session token
      const result = {};

      if (error && error.code === _node.default.Error.INVALID_SESSION_TOKEN) {
        // Store a resolved promise with the error for 10 minutes
        result.error = error;
        this.authCache.set(sessionToken, Promise.resolve(result), 60 * 10 * 1000);
      } else {
        this.authCache.del(sessionToken);
      }

      return result;
    });
    this.authCache.set(sessionToken, authPromise);
    return authPromise;
  }

  async _matchesCLP(classLevelPermissions, object, client, requestId, op) {
    // try to match on user first, less expensive than with roles
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    const aclGroup = ['*'];
    let userId;

    if (typeof subscriptionInfo !== 'undefined') {
      const {
        userId
      } = await this.getAuthForSessionToken(subscriptionInfo.sessionToken);

      if (userId) {
        aclGroup.push(userId);
      }
    }

    try {
      await _SchemaController.default.validatePermission(classLevelPermissions, object.className, aclGroup, op);
      return true;
    } catch (e) {
      _logger.default.verbose(`Failed matching CLP for ${object.id} ${userId} ${e}`);

      return false;
    } // TODO: handle roles permissions
    // Object.keys(classLevelPermissions).forEach((key) => {
    //   const perm = classLevelPermissions[key];
    //   Object.keys(perm).forEach((key) => {
    //     if (key.indexOf('role'))
    //   });
    // })
    // // it's rejected here, check the roles
    // var rolesQuery = new Parse.Query(Parse.Role);
    // rolesQuery.equalTo("users", user);
    // return rolesQuery.find({useMasterKey:true});

  }

  _getCLPOperation(query) {
    return typeof query === 'object' && Object.keys(query).length == 1 && typeof query.objectId === 'string' ? 'get' : 'find';
  }

  async _verifyACL(acl, token) {
    if (!token) {
      return false;
    }

    const {
      auth,
      userId
    } = await this.getAuthForSessionToken(token); // Getting the session token failed
    // This means that no additional auth is available
    // At this point, just bail out as no additional visibility can be inferred.

    if (!auth || !userId) {
      return false;
    }

    const isSubscriptionSessionTokenMatched = acl.getReadAccess(userId);

    if (isSubscriptionSessionTokenMatched) {
      return true;
    } // Check if the user has any roles that match the ACL


    return Promise.resolve().then(async () => {
      // Resolve false right away if the acl doesn't have any roles
      const acl_has_roles = Object.keys(acl.permissionsById).some(key => key.startsWith('role:'));

      if (!acl_has_roles) {
        return false;
      }

      this.sessionTokenCache.getUserId(subscriptionSessionToken).then(userId => {
        // Pass along a null if there is no user id
        if (!userId) {
          return _node.default.Promise.as(null);
        }

        var user = new _node.default.User();
        user.id = userId;
        return user;
      }).then(user => {
        // Pass along an empty array (of roles) if no user
        if (!user) {
          return _node.default.Promise.as([]);
        }

        if (this.cacheController && this.cacheController.adapter && this.cacheController.adapter instanceof _RedisCacheAdapter.default) {
          return this.cacheController.role.get(user.id).then(roles => {
            if (roles != null) {
              console.log('LiveQuery: using roles from cache for user ' + user.id);
              return roles.map(role => role.replace(/^role:/, ''));
            }

            console.log('LiveQuery: loading roles from database as they\'re not cached for user ' + user.id);
            return this.loadRolesDelegate(user, this.cacheController).then(roles => {
              console.log(`LiveQuery: user: ${user.id}loaded roles:` + roles);
              this.cacheController.role.put(user.id, roles.map(role => 'role:' + role));
              return roles;
            });
          });
        } else {
          // fallback to direct query
          console.log('LiveQuery: fallback: loading roles from database for user ' + user.id);
          return this.loadRolesDelegate(user, this.cacheController);
        }
      }).then(roles => {
        // Finally, see if any of the user's roles allow them read access
        return !!~roles.findIndex(role => acl.getRoleReadAccess(role));
      }).catch(error => {
        console.log('LiveQuery: error:', error);
        return false;
      });
    });
  }

  async _matchesACL(acl, client, requestId) {
    // Return true directly if ACL isn't present, ACL is public read, or client has master key
    if (!acl || acl.getPublicReadAccess() || client.hasMasterKey) {
      return true;
    } // Check subscription sessionToken matches ACL first


    const subscriptionInfo = client.getSubscriptionInfo(requestId);

    if (typeof subscriptionInfo === 'undefined') {
      return false;
    }

    const subscriptionToken = subscriptionInfo.sessionToken;
    const clientSessionToken = client.sessionToken;

    if (await this._verifyACL(acl, subscriptionToken)) {
      return true;
    }

    if (await this._verifyACL(acl, clientSessionToken)) {
      return true;
    }

    return false;
  }

  _handleConnect(parseWebsocket, request) {
    if (!this._validateKeys(request, this.keyPairs)) {
      _Client.Client.pushError(parseWebsocket, 4, 'Key in request is not valid');

      _logger.default.error('Key in request is not valid');

      return;
    }

    const hasMasterKey = this._hasMasterKey(request, this.keyPairs);

    const clientId = (0, _uuid.default)();
    const client = new _Client.Client(clientId, parseWebsocket, hasMasterKey);
    parseWebsocket.clientId = clientId;
    this.clients.set(parseWebsocket.clientId, client);

    _logger.default.info(`Create new client: ${parseWebsocket.clientId}`);

    client.pushConnect();
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _hasMasterKey(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0 || !validKeyPairs.has('masterKey')) {
      return false;
    }

    if (!request || !request.hasOwnProperty('masterKey')) {
      return false;
    }

    return request.masterKey === validKeyPairs.get('masterKey');
  }

  _validateKeys(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0) {
      return true;
    }

    let isValid = false;

    for (const [key, secret] of validKeyPairs) {
      if (!request[key] || request[key] !== secret) {
        continue;
      }

      isValid = true;
      break;
    }

    return isValid;
  }

  _handleSubscribe(parseWebsocket, request) {
    // If we can not find this client, return error to client
    if (!parseWebsocket.hasOwnProperty('clientId')) {
      _Client.Client.pushError(parseWebsocket, 2, 'Can not find this client, make sure you connect to server before subscribing');

      _logger.default.error('Can not find this client, make sure you connect to server before subscribing');

      return;
    }

    const client = this.clients.get(parseWebsocket.clientId); // Get subscription from subscriptions, create one if necessary

    const subscriptionHash = (0, _QueryTools.queryHash)(request.query); // Add className to subscriptions if necessary

    const className = request.query.className;

    if (!this.subscriptions.has(className)) {
      this.subscriptions.set(className, new Map());
    }

    const classSubscriptions = this.subscriptions.get(className);
    let subscription;

    if (classSubscriptions.has(subscriptionHash)) {
      subscription = classSubscriptions.get(subscriptionHash);
    } else {
      subscription = new _Subscription.Subscription(className, request.query.where, subscriptionHash);
      classSubscriptions.set(subscriptionHash, subscription);
    } // Add subscriptionInfo to client


    const subscriptionInfo = {
      subscription: subscription
    }; // Add selected fields and sessionToken for this subscription if necessary

    if (request.query.fields) {
      subscriptionInfo.fields = request.query.fields;
    }

    if (request.sessionToken) {
      subscriptionInfo.sessionToken = request.sessionToken;
    }

    client.addSubscriptionInfo(request.requestId, subscriptionInfo); // Add clientId to subscription

    subscription.addClientSubscription(parseWebsocket.clientId, request.requestId);
    client.pushSubscribe(request.requestId);

    _logger.default.verbose(`Create client ${parseWebsocket.clientId} new subscription: ${request.requestId}`);

    _logger.default.verbose('Current client number: %d', this.clients.size);

    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'subscribe',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _handleUpdateSubscription(parseWebsocket, request) {
    this._handleUnsubscribe(parseWebsocket, request, false);

    this._handleSubscribe(parseWebsocket, request);
  }

  _handleUnsubscribe(parseWebsocket, request, notifyClient = true) {
    // If we can not find this client, return error to client
    if (!parseWebsocket.hasOwnProperty('clientId')) {
      _Client.Client.pushError(parseWebsocket, 2, 'Can not find this client, make sure you connect to server before unsubscribing');

      _logger.default.error('Can not find this client, make sure you connect to server before unsubscribing');

      return;
    }

    const requestId = request.requestId;
    const client = this.clients.get(parseWebsocket.clientId);

    if (typeof client === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find client with clientId ' + parseWebsocket.clientId + '. Make sure you connect to live query server before unsubscribing.');

      _logger.default.error('Can not find this client ' + parseWebsocket.clientId);

      return;
    }

    const subscriptionInfo = client.getSubscriptionInfo(requestId);

    if (typeof subscriptionInfo === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId + '. Make sure you subscribe to live query server before unsubscribing.');

      _logger.default.error('Can not find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId);

      return;
    } // Remove subscription from client


    client.deleteSubscriptionInfo(requestId); // Remove client from subscription

    const subscription = subscriptionInfo.subscription;
    const className = subscription.className;
    subscription.deleteClientSubscription(parseWebsocket.clientId, requestId); // If there is no client which is subscribing this subscription, remove it from subscriptions

    const classSubscriptions = this.subscriptions.get(className);

    if (!subscription.hasSubscribingClient()) {
      classSubscriptions.delete(subscription.hash);
    } // If there is no subscriptions under this class, remove it from subscriptions


    if (classSubscriptions.size === 0) {
      this.subscriptions.delete(className);
    }

    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'unsubscribe',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });

    if (!notifyClient) {
      return;
    }

    client.pushUnsubscribe(request.requestId);

    _logger.default.verbose(`Delete client: ${parseWebsocket.clientId} | subscription: ${request.requestId}`);
  }

}

exports.ParseLiveQueryServer = ParseLiveQueryServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9MaXZlUXVlcnkvUGFyc2VMaXZlUXVlcnlTZXJ2ZXIuanMiXSwibmFtZXMiOlsiZ2V0QWxsUm9sZXNOYW1lc0ZvclJvbGVJZHMiLCJyb2xlSURzIiwibmFtZXMiLCJxdWVyaWVkUm9sZXMiLCJpbnMiLCJmaWx0ZXIiLCJyb2xlSWQiLCJtYXAiLCJyb2xlIiwiUGFyc2UiLCJSb2xlIiwiaWQiLCJsZW5ndGgiLCJQcm9taXNlIiwicmVzb2x2ZSIsInF1ZXJ5IiwiUXVlcnkiLCJjb250YWluZWRJbiIsImxpbWl0IiwiZmluZCIsInVzZU1hc3RlcktleSIsInRoZW4iLCJyb2xlcyIsImlkcyIsInB1c2giLCJnZXROYW1lIiwiZGVmYXVsdExvYWRSb2xlc0RlbGVnYXRlIiwiYXV0aCIsImdldFVzZXJSb2xlcyIsIlBhcnNlTGl2ZVF1ZXJ5U2VydmVyIiwiY29uc3RydWN0b3IiLCJzZXJ2ZXIiLCJjb25maWciLCJjbGllbnRzIiwiTWFwIiwic3Vic2NyaXB0aW9ucyIsImFwcElkIiwiYXBwbGljYXRpb25JZCIsIm1hc3RlcktleSIsImtleVBhaXJzIiwia2V5IiwiT2JqZWN0Iiwia2V5cyIsInNldCIsImxvZ2dlciIsInZlcmJvc2UiLCJkaXNhYmxlU2luZ2xlSW5zdGFuY2UiLCJzZXJ2ZXJVUkwiLCJpbml0aWFsaXplIiwiamF2YVNjcmlwdEtleSIsImNhY2hlQ29udHJvbGxlciIsImNhY2hlQWRhcHRlciIsIlJlZGlzQ2FjaGVBZGFwdGVyIiwiY2FjaGVDb250cm9sbGVyQWRhcHRlciIsIkluTWVtb3J5Q2FjaGVBZGFwdGVyIiwiQ2FjaGVDb250cm9sbGVyIiwiYXV0aENhY2hlIiwiTFJVIiwibWF4IiwibWF4QWdlIiwicGFyc2VXZWJTb2NrZXRTZXJ2ZXIiLCJQYXJzZVdlYlNvY2tldFNlcnZlciIsInBhcnNlV2Vic29ja2V0IiwiX29uQ29ubmVjdCIsIndlYnNvY2tldFRpbWVvdXQiLCJzdWJzY3JpYmVyIiwiUGFyc2VQdWJTdWIiLCJjcmVhdGVTdWJzY3JpYmVyIiwic3Vic2NyaWJlIiwib24iLCJjaGFubmVsIiwibWVzc2FnZVN0ciIsIm1lc3NhZ2UiLCJKU09OIiwicGFyc2UiLCJlIiwiZXJyb3IiLCJfaW5mbGF0ZVBhcnNlT2JqZWN0IiwiX29uQWZ0ZXJTYXZlIiwiX29uQWZ0ZXJEZWxldGUiLCJzZXNzaW9uVG9rZW5DYWNoZSIsIlNlc3Npb25Ub2tlbkNhY2hlIiwiY2FjaGVUaW1lb3V0IiwicXVlcnlNaWRkbGV3YXJlIiwibG9hZFJvbGVzRGVsZWdhdGUiLCJjb25zb2xlIiwibG9nIiwiY3VycmVudFBhcnNlT2JqZWN0IiwiVXNlclJvdXRlciIsInJlbW92ZUhpZGRlblByb3BlcnRpZXMiLCJjbGFzc05hbWUiLCJwYXJzZU9iamVjdCIsIl9maW5pc2hGZXRjaCIsIm9yaWdpbmFsUGFyc2VPYmplY3QiLCJkZWxldGVkUGFyc2VPYmplY3QiLCJ0b0pTT04iLCJjbGFzc0xldmVsUGVybWlzc2lvbnMiLCJzaXplIiwiY2xhc3NTdWJzY3JpcHRpb25zIiwiZ2V0IiwiZGVidWciLCJzdWJzY3JpcHRpb24iLCJ2YWx1ZXMiLCJpc1N1YnNjcmlwdGlvbk1hdGNoZWQiLCJfbWF0Y2hlc1N1YnNjcmlwdGlvbiIsImNsaWVudElkIiwicmVxdWVzdElkcyIsIl8iLCJlbnRyaWVzIiwiY2xpZW50UmVxdWVzdElkcyIsImNsaWVudCIsInJlcXVlc3RJZCIsImFjbCIsImdldEFDTCIsIm9wIiwiX2dldENMUE9wZXJhdGlvbiIsIl9tYXRjaGVzQ0xQIiwiX21hdGNoZXNBQ0wiLCJpc01hdGNoZWQiLCJwdXNoRGVsZXRlIiwiY2F0Y2giLCJpc09yaWdpbmFsU3Vic2NyaXB0aW9uTWF0Y2hlZCIsImlzQ3VycmVudFN1YnNjcmlwdGlvbk1hdGNoZWQiLCJvcmlnaW5hbEFDTENoZWNraW5nUHJvbWlzZSIsIm9yaWdpbmFsQUNMIiwiY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSIsImN1cnJlbnRBQ0wiLCJhbGwiLCJpc09yaWdpbmFsTWF0Y2hlZCIsImlzQ3VycmVudE1hdGNoZWQiLCJoYXNoIiwidHlwZSIsImZ1bmN0aW9uTmFtZSIsInNzVG9rZW4iLCJnZXRTdWJzY3JpcHRpb25JbmZvIiwic2Vzc2lvblRva2VuIiwiZ2V0VXNlcklkIiwidXNlcklkIiwiY1VzZXIiLCJVc2VyIiwiZXF1YWxUbyIsInVzZXIiLCJ1bmRlZmluZWQiLCJwdXQiLCJzdHJpbmdpZnkiLCJyZXN1bHQiLCJmb3JFYWNoIiwid2FyZSIsImdldFRlYW1zIiwidGVhbXMiLCJyZXF1ZXN0IiwidHY0IiwidmFsaWRhdGUiLCJSZXF1ZXN0U2NoZW1hIiwiQ2xpZW50IiwicHVzaEVycm9yIiwiX2hhbmRsZUNvbm5lY3QiLCJfaGFuZGxlU3Vic2NyaWJlIiwiX2hhbmRsZVVwZGF0ZVN1YnNjcmlwdGlvbiIsIl9oYW5kbGVVbnN1YnNjcmliZSIsImluZm8iLCJoYXMiLCJldmVudCIsImRlbGV0ZSIsInN1YnNjcmlwdGlvbkluZm8iLCJzdWJzY3JpcHRpb25JbmZvcyIsImRlbGV0ZUNsaWVudFN1YnNjcmlwdGlvbiIsImhhc1N1YnNjcmliaW5nQ2xpZW50IiwiZ2V0QXV0aEZvclNlc3Npb25Ub2tlbiIsImZyb21DYWNoZSIsImF1dGhQcm9taXNlIiwiY29kZSIsIkVycm9yIiwiSU5WQUxJRF9TRVNTSU9OX1RPS0VOIiwiZGVsIiwib2JqZWN0IiwiYWNsR3JvdXAiLCJTY2hlbWFDb250cm9sbGVyIiwidmFsaWRhdGVQZXJtaXNzaW9uIiwib2JqZWN0SWQiLCJfdmVyaWZ5QUNMIiwidG9rZW4iLCJpc1N1YnNjcmlwdGlvblNlc3Npb25Ub2tlbk1hdGNoZWQiLCJnZXRSZWFkQWNjZXNzIiwiYWNsX2hhc19yb2xlcyIsInBlcm1pc3Npb25zQnlJZCIsInNvbWUiLCJzdGFydHNXaXRoIiwic3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuIiwiYXMiLCJhZGFwdGVyIiwicmVwbGFjZSIsImZpbmRJbmRleCIsImdldFJvbGVSZWFkQWNjZXNzIiwiZ2V0UHVibGljUmVhZEFjY2VzcyIsImhhc01hc3RlcktleSIsInN1YnNjcmlwdGlvblRva2VuIiwiY2xpZW50U2Vzc2lvblRva2VuIiwiX3ZhbGlkYXRlS2V5cyIsIl9oYXNNYXN0ZXJLZXkiLCJwdXNoQ29ubmVjdCIsInZhbGlkS2V5UGFpcnMiLCJoYXNPd25Qcm9wZXJ0eSIsImlzVmFsaWQiLCJzZWNyZXQiLCJzdWJzY3JpcHRpb25IYXNoIiwiU3Vic2NyaXB0aW9uIiwid2hlcmUiLCJmaWVsZHMiLCJhZGRTdWJzY3JpcHRpb25JbmZvIiwiYWRkQ2xpZW50U3Vic2NyaXB0aW9uIiwicHVzaFN1YnNjcmliZSIsIm5vdGlmeUNsaWVudCIsImRlbGV0ZVN1YnNjcmlwdGlvbkluZm8iLCJwdXNoVW5zdWJzY3JpYmUiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFBQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7OztBQUVBLFNBQVNBLDBCQUFULENBQW9DQyxPQUFwQyxFQUFrREMsS0FBbEQsRUFBOERDLFlBQTlELEVBQWlGO0FBQy9FLFFBQU1DLEdBQUcsR0FBR0gsT0FBTyxDQUFDSSxNQUFSLENBQWdCQyxNQUFELElBQVk7QUFDckMsV0FBT0gsWUFBWSxDQUFDRyxNQUFELENBQVosS0FBeUIsSUFBaEM7QUFDRCxHQUZXLEVBRVRDLEdBRlMsQ0FFSkQsTUFBRCxJQUFZO0FBQ2pCSCxJQUFBQSxZQUFZLENBQUNHLE1BQUQsQ0FBWixHQUF1QixJQUF2QjtBQUNBLFVBQU1FLElBQUksR0FBRyxJQUFJQyxjQUFNQyxJQUFWLEVBQWI7QUFDQUYsSUFBQUEsSUFBSSxDQUFDRyxFQUFMLEdBQVVMLE1BQVY7QUFDQSxXQUFPRSxJQUFQO0FBQ0QsR0FQVyxDQUFaOztBQVFBLE1BQUlKLEdBQUcsQ0FBQ1EsTUFBSixLQUFlLENBQW5CLEVBQXNCO0FBQ3BCLFdBQU9DLE9BQU8sQ0FBQ0MsT0FBUixDQUFn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U0FBL0I7QUFDQVcsSUFBQUEsWUFBWSxDQUFDaUUsd0JBQWIsQ0FBc0N4RyxjQUFjLENBQUMyQyxRQUFyRCxFQUErRE0sU0FBL0QsRUFwREssQ0FxREw7O0FBQ0EsVUFBTWIsa0JBQWtCLEdBQUcsS0FBSy9ELGFBQUwsQ0FBbUJnRSxHQUFuQixDQUF1QlQsU0FBdkIsQ0FBM0I7O0FBQ0EsUUFBSSxDQUFDVyxZQUFZLENBQUNrRSxvQkFBYixFQUFMLEVBQTBDO0FBQ3hDckUsTUFBQUEsa0JBQWtCLENBQUNpRSxNQUFuQixDQUEwQjlELFlBQVksQ0FBQzZCLElBQXZDO0FBQ0QsS0F6REksQ0EwREw7OztBQUNBLFFBQUloQyxrQkFBa0IsQ0FBQ0QsSUFBbkIsS0FBNEIsQ0FBaEMsRUFBbUM7QUFDakMsV0FBSzlELGFBQUwsQ0FBbUJnSSxNQUFuQixDQUEwQnpFLFNBQTFCO0FBQ0Q7O0FBQ0QsNkNBQTBCO0FBQ3hCd0UsTUFBQUEsS0FBSyxFQUFFLGFBRGlCO0FBRXhCakksTUFBQUEsT0FBTyxFQUFFLEtBQUtBLE9BQUwsQ0FBYWdFLElBRkU7QUFHeEI5RCxNQUFBQSxhQUFhLEVBQUUsS0FBS0EsYUFBTCxDQUFtQjhEO0FBSFYsS0FBMUI7O0FBTUEsUUFBSSxDQUFDbUgsWUFBTCxFQUFtQjtBQUNqQjtBQUNEOztBQUVEdEcsSUFBQUEsTUFBTSxDQUFDd0csZUFBUCxDQUF1QmhFLE9BQU8sQ0FBQ3ZDLFNBQS9COztBQUVBbkUsb0JBQU9DLE9BQVAsQ0FDRyxrQkFBaUJpQixjQUFjLENBQUMyQyxRQUFTLG9CQUN4QzZDLE9BQU8sQ0FBQ3ZDLFNBQ1QsRUFISDtBQUtEOztBQXR6QndCIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR2NCBmcm9tICd0djQnO1xuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgU3Vic2NyaXB0aW9uIH0gZnJvbSAnLi9TdWJzY3JpcHRpb24nO1xuaW1wb3J0IHsgQ2xpZW50IH0gZnJvbSAnLi9DbGllbnQnO1xuaW1wb3J0IHsgUGFyc2VXZWJTb2NrZXRTZXJ2ZXIgfSBmcm9tICcuL1BhcnNlV2ViU29ja2V0U2VydmVyJztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi4vbG9nZ2VyJztcbmltcG9ydCBSZXF1ZXN0U2NoZW1hIGZyb20gJy4vUmVxdWVzdFNjaGVtYSc7XG5pbXBvcnQgeyBtYXRjaGVzUXVlcnksIHF1ZXJ5SGFzaCB9IGZyb20gJy4vUXVlcnlUb29scyc7XG5pbXBvcnQgeyBQYXJzZVB1YlN1YiB9IGZyb20gJy4vUGFyc2VQdWJTdWInO1xuaW1wb3J0IFNjaGVtYUNvbnRyb2xsZXIgZnJvbSAnLi4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcic7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IHV1aWQgZnJvbSAndXVpZCc7XG5pbXBvcnQgeyBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIH0gZnJvbSAnLi4vdHJpZ2dlcnMnO1xuaW1wb3J0IHsgZ2V0QXV0aEZvclNlc3Npb25Ub2tlbiwgQXV0aCB9IGZyb20gJy4uL0F1dGgnO1xuaW1wb3J0IHsgZ2V0Q2FjaGVDb250cm9sbGVyIH0gZnJvbSAnLi4vQ29udHJvbGxlcnMnO1xuaW1wb3J0IExSVSBmcm9tICdscnUtY2FjaGUnO1xuaW1wb3J0IFVzZXJSb3V0ZXIgZnJvbSAnLi4vUm91dGVycy9Vc2Vyc1JvdXRlcic7XG5pbXBvcnQgeyBsb2FkQWRhcHRlciB9ICAgICAgICAgIGZyb20gJy4uL0FkYXB0ZXJzL0FkYXB0ZXJMb2FkZXInO1xuaW1wb3J0IHsgSW5NZW1vcnlDYWNoZUFkYXB0ZXIgfSBmcm9tICcuLi9BZGFwdGVycy9DYWNoZS9Jbk1lbW9yeUNhY2hlQWRhcHRlcic7XG5pbXBvcnQgeyBDYWNoZUNvbnRyb2xsZXIgfSAgICAgIGZyb20gJy4uL0NvbnRyb2xsZXJzL0NhY2hlQ29udHJvbGxlcic7XG5pbXBvcnQgUmVkaXNDYWNoZUFkYXB0ZXIgICAgICAgIGZyb20gJy4uL0FkYXB0ZXJzL0NhY2hlL1JlZGlzQ2FjaGVBZGFwdGVyJztcbmltcG9ydCB7IFNlc3Npb25Ub2tlbkNhY2hlIH0gZnJvbSAnLi9TZXNzaW9uVG9rZW5DYWNoZSc7XG5cbmZ1bmN0aW9uIGdldEFsbFJvbGVzTmFtZXNGb3JSb2xlSWRzKHJvbGVJRHM6IGFueSwgbmFtZXM6IGFueSwgcXVlcmllZFJvbGVzOiBhbnkpIHtcbiAgY29uc3QgaW5zID0gcm9sZUlEcy5maWx0ZXIoKHJvbGVJZCkgPT4ge1xuICAgIHJldHVybiBxdWVyaWVkUm9sZXNbcm9sZUlkXSAhPT0gdHJ1ZTtcbiAgfSkubWFwKChyb2xlSWQpID0+IHtcbiAgICBxdWVyaWVkUm9sZXNbcm9sZUlkXSA9IHRydWU7XG4gICAgY29uc3Qgcm9sZSA9IG5ldyBQYXJzZS5Sb2xlKCk7XG4gICAgcm9sZS5pZCA9IHJvbGVJZDtcbiAgICByZXR1cm4gcm9sZTtcbiAgfSk7XG4gIGlmIChpbnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShbLi4ubmFtZXNdKTtcbiAgfVxuXG4gIGNvbnN0IHF1ZXJ5ID0gbmV3IFBhcnNlLlF1ZXJ5KFBhcnNlLlJvbGUpO1xuICBxdWVyeS5jb250YWluZWRJbigncm9sZXMnLCBpbnMpO1xuICBxdWVyeS5saW1pdCgxMDAwMCk7XG4gIHJldHVybiBxdWVyeS5maW5kKHt1c2VNYXN0ZXJLZXk6IHRydWV9KS50aGVuKChyb2xlcykgPT4ge1xuICAgIGlmICghcm9sZXMubGVuZ3RoKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG5hbWVzKTtcbiAgICB9XG5cbiAgICBjb25zdCBpZHMgPSBbXTtcbiAgICByb2xlcy5tYXAoKHJvbGUpID0+IHtcbiAgICAgIG5hbWVzLnB1c2gocm9sZS5nZXROYW1lKCkpO1xuICAgICAgaWRzLnB1c2gocm9sZS5pZCk7XG4gICAgICBxdWVyaWVkUm9sZXNbcm9sZS5pZF0gPSBxdWVyaWVkUm9sZXNbcm9sZS5pZF0gfHwgZmFsc2U7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gZ2V0QWxsUm9sZXNOYW1lc0ZvclJvbGVJZHMoaWRzLCBuYW1lcywgcXVlcmllZFJvbGVzKTtcbiAgfSkudGhlbigobmFtZXMpID0+IHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFsuLi5uYW1lc10pO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gZGVmYXVsdExvYWRSb2xlc0RlbGVnYXRlKGF1dGg6IGFueSkge1xuICByZXR1cm4gYXV0aC5nZXRVc2VyUm9sZXMoKTtcbn1cblxuY2xhc3MgUGFyc2VMaXZlUXVlcnlTZXJ2ZXIge1xuICBjbGllbnRzOiBNYXA7XG4gIC8vIGNsYXNzTmFtZSAtPiAocXVlcnlIYXNoIC0+IHN1YnNjcmlwdGlvbilcbiAgc3Vic2NyaXB0aW9uczogT2JqZWN0O1xuICBwYXJzZVdlYlNvY2tldFNlcnZlcjogT2JqZWN0O1xuICBrZXlQYWlyczogYW55O1xuICAvLyBUaGUgc3Vic2NyaWJlciB3ZSB1c2UgdG8gZ2V0IG9iamVjdCB1cGRhdGUgZnJvbSBwdWJsaXNoZXJcbiAgc3Vic2NyaWJlcjogT2JqZWN0O1xuICBjYWNoZUNvbnRyb2xsZXI6IGFueTtcblxuICBjb25zdHJ1Y3RvcihzZXJ2ZXI6IGFueSwgY29uZmlnOiBhbnkgPSB7fSkge1xuICAgIHRoaXMuc2VydmVyID0gc2VydmVyO1xuICAgIHRoaXMuY2xpZW50cyA9IG5ldyBNYXAoKTtcbiAgICB0aGlzLnN1YnNjcmlwdGlvbnMgPSBuZXcgTWFwKCk7XG5cbiAgICBjb25maWcuYXBwSWQgPSBjb25maWcuYXBwSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgICBjb25maWcubWFzdGVyS2V5ID0gY29uZmlnLm1hc3RlcktleSB8fCBQYXJzZS5tYXN0ZXJLZXk7XG5cbiAgICAvLyBTdG9yZSBrZXlzLCBjb252ZXJ0IG9iaiB0byBtYXBcbiAgICBjb25zdCBrZXlQYWlycyA9IGNvbmZpZy5rZXlQYWlycyB8fCB7fTtcbiAgICB0aGlzLmtleVBhaXJzID0gbmV3IE1hcCgpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGtleVBhaXJzKSkge1xuICAgICAgdGhpcy5rZXlQYWlycy5zZXQoa2V5LCBrZXlQYWlyc1trZXldKTtcbiAgICB9XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ1N1cHBvcnQga2V5IHBhaXJzJywgdGhpcy5rZXlQYWlycyk7XG5cbiAgICAvLyBJbml0aWFsaXplIFBhcnNlXG4gICAgUGFyc2UuT2JqZWN0LmRpc2FibGVTaW5nbGVJbnN0YW5jZSgpO1xuICAgIGNvbnN0IHNlcnZlclVSTCA9IGNvbmZpZy5zZXJ2ZXJVUkwgfHwgUGFyc2Uuc2VydmVyVVJMO1xuICAgIFBhcnNlLnNlcnZlclVSTCA9IHNlcnZlclVSTDtcbiAgICBQYXJzZS5pbml0aWFsaXplKGNvbmZpZy5hcHBJZCwgUGFyc2UuamF2YVNjcmlwdEtleSwgY29uZmlnLm1hc3RlcktleSk7XG5cbiAgICAvLyBUaGUgY2FjaGUgY29udHJvbGxlciBpcyBhIHByb3BlciBjYWNoZSBjb250cm9sbGVyXG4gICAgLy8gd2l0aCBhY2Nlc3MgdG8gVXNlciBhbmQgUm9sZXNcbiAgICB0aGlzLmNhY2hlQ29udHJvbGxlciA9IGdldENhY2hlQ29udHJvbGxlcihjb25maWcpO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBjYWNoZVxuICAgIGlmIChjb25maWcuY2FjaGVBZGFwdGVyIGluc3RhbmNlb2YgUmVkaXNDYWNoZUFkYXB0ZXIpIHtcbiAgICAgIGNvbnN0IGNhY2hlQ29udHJvbGxlckFkYXB0ZXIgPSBsb2FkQWRhcHRlcihjb25maWcuY2FjaGVBZGFwdGVyLCBJbk1lbW9yeUNhY2hlQWRhcHRlciwge2FwcElkOiBjb25maWcuYXBwSWR9KTtcbiAgICAgIHRoaXMuY2FjaGVDb250cm9sbGVyID0gbmV3IENhY2hlQ29udHJvbGxlcihjYWNoZUNvbnRyb2xsZXJBZGFwdGVyLCBjb25maWcuYXBwSWQpO1xuICAgIH1cbiAgICAvLyBUaGlzIGF1dGggY2FjaGUgc3RvcmVzIHRoZSBwcm9taXNlcyBmb3IgZWFjaCBhdXRoIHJlc29sdXRpb24uXG4gICAgLy8gVGhlIG1haW4gYmVuZWZpdCBpcyB0byBiZSBhYmxlIHRvIHJldXNlIHRoZSBzYW1lIHVzZXIgLyBzZXNzaW9uIHRva2VuIHJlc29sdXRpb24uXG4gICAgdGhpcy5hdXRoQ2FjaGUgPSBuZXcgTFJVKHtcbiAgICAgIG1heDogNTAwLCAvLyA1MDAgY29uY3VycmVudFxuICAgICAgbWF4QWdlOiA2MCAqIDYwICogMTAwMCwgLy8gMWhcbiAgICB9KTtcbiAgICAvLyBJbml0aWFsaXplIHdlYnNvY2tldCBzZXJ2ZXJcbiAgICB0aGlzLnBhcnNlV2ViU29ja2V0U2VydmVyID0gbmV3IFBhcnNlV2ViU29ja2V0U2VydmVyKFxuICAgICAgc2VydmVyLFxuICAgICAgcGFyc2VXZWJzb2NrZXQgPT4gdGhpcy5fb25Db25uZWN0KHBhcnNlV2Vic29ja2V0KSxcbiAgICAgIGNvbmZpZy53ZWJzb2NrZXRUaW1lb3V0XG4gICAgKTtcblxuICAgIC8vIEluaXRpYWxpemUgc3Vic2NyaWJlclxuICAgIHRoaXMuc3Vic2NyaWJlciA9IFBhcnNlUHViU3ViLmNyZWF0ZVN1YnNjcmliZXIoY29uZmlnKTtcbiAgICB0aGlzLnN1YnNjcmliZXIuc3Vic2NyaWJlKFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJTYXZlJyk7XG4gICAgdGhpcy5zdWJzY3JpYmVyLnN1YnNjcmliZShQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlJyk7XG4gICAgLy8gUmVnaXN0ZXIgbWVzc2FnZSBoYW5kbGVyIGZvciBzdWJzY3JpYmVyLiBXaGVuIHB1Ymxpc2hlciBnZXQgbWVzc2FnZXMsIGl0IHdpbGwgcHVibGlzaCBtZXNzYWdlXG4gICAgLy8gdG8gdGhlIHN1YnNjcmliZXJzIGFuZCB0aGUgaGFuZGxlciB3aWxsIGJlIGNhbGxlZC5cbiAgICB0aGlzLnN1YnNjcmliZXIub24oJ21lc3NhZ2UnLCAoY2hhbm5lbCwgbWVzc2FnZVN0cikgPT4ge1xuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ1N1YnNjcmliZSBtZXNzc2FnZSAlaicsIG1lc3NhZ2VTdHIpO1xuICAgICAgbGV0IG1lc3NhZ2U7XG4gICAgICB0cnkge1xuICAgICAgICBtZXNzYWdlID0gSlNPTi5wYXJzZShtZXNzYWdlU3RyKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKCd1bmFibGUgdG8gcGFyc2UgbWVzc2FnZScsIG1lc3NhZ2VTdHIsIGUpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLl9pbmZsYXRlUGFyc2VPYmplY3QobWVzc2FnZSk7XG4gICAgICBpZiAoY2hhbm5lbCA9PT0gUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUnKSB7XG4gICAgICAgIHRoaXMuX29uQWZ0ZXJTYXZlKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIGlmIChjaGFubmVsID09PSBQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlJykge1xuICAgICAgICB0aGlzLl9vbkFmdGVyRGVsZXRlKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKFxuICAgICAgICAgICdHZXQgbWVzc2FnZSAlcyBmcm9tIHVua25vd24gY2hhbm5lbCAlaicsXG4gICAgICAgICAgbWVzc2FnZSxcbiAgICAgICAgICBjaGFubmVsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgLy8gSW5pdGlhbGl6ZSBzZXNzaW9uVG9rZW4gY2FjaGVcbiAgICB0aGlzLnNlc3Npb25Ub2tlbkNhY2hlID0gbmV3IFNlc3Npb25Ub2tlbkNhY2hlKGNvbmZpZy5jYWNoZVRpbWVvdXQpO1xuXG4gICAgLy8gaG9vayB1cCBxdWVyeU1pZGRsZXdhcmVcbiAgICB0aGlzLnF1ZXJ5TWlkZGxld2FyZSA9IGNvbmZpZy5xdWVyeU1pZGRsZXdhcmUgfHwgW107XG5cbiAgICB0aGlzLmxvYWRSb2xlc0RlbGVnYXRlID0gY29uZmlnLmxvYWRSb2xlc0RlbGVnYXRlIHx8IGRlZmF1bHRMb2FkUm9sZXNEZWxlZ2F0ZTtcblxuICAgIGNvbnNvbGUubG9nKCdQYXJzZUxpdmVRdWVyeVNlcnZlciAtIHRoaXMubG9hZFJvbGVzRGVsZWdhdGU6JywgdGhpcy5sb2FkUm9sZXNEZWxlZ2F0ZSk7XG5cbiAgfVxuXG4gIC8vIE1lc3NhZ2UgaXMgdGhlIEpTT04gb2JqZWN0IGZyb20gcHVibGlzaGVyLiBNZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCBpcyB0aGUgUGFyc2VPYmplY3QgSlNPTiBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0IEpTT04uXG4gIF9pbmZsYXRlUGFyc2VPYmplY3QobWVzc2FnZTogYW55KTogdm9pZCB7XG4gICAgLy8gSW5mbGF0ZSBtZXJnZWQgb2JqZWN0XG4gICAgY29uc3QgY3VycmVudFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3Q7XG4gICAgVXNlclJvdXRlci5yZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzKGN1cnJlbnRQYXJzZU9iamVjdCk7XG4gICAgbGV0IGNsYXNzTmFtZSA9IGN1cnJlbnRQYXJzZU9iamVjdC5jbGFzc05hbWU7XG4gICAgbGV0IHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgIHBhcnNlT2JqZWN0Ll9maW5pc2hGZXRjaChjdXJyZW50UGFyc2VPYmplY3QpO1xuICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgLy8gSW5mbGF0ZSBvcmlnaW5hbCBvYmplY3RcbiAgICBjb25zdCBvcmlnaW5hbFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0O1xuICAgIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICBVc2VyUm91dGVyLnJlbW92ZUhpZGRlblByb3BlcnRpZXMob3JpZ2luYWxQYXJzZU9iamVjdCk7XG4gICAgICBjbGFzc05hbWUgPSBvcmlnaW5hbFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICAgIHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgICAgcGFyc2VPYmplY3QuX2ZpbmlzaEZldGNoKG9yaWdpbmFsUGFyc2VPYmplY3QpO1xuICAgICAgbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgfVxuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIgYWZ0ZXIgaW5mbGF0ZWQuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0LlxuICBfb25BZnRlckRlbGV0ZShtZXNzYWdlOiBhbnkpOiB2b2lkIHtcbiAgICBsb2dnZXIudmVyYm9zZShQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlIGlzIHRyaWdnZXJlZCcpO1xuXG4gICAgY29uc3QgZGVsZXRlZFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QudG9KU09OKCk7XG4gICAgY29uc3QgY2xhc3NMZXZlbFBlcm1pc3Npb25zID0gbWVzc2FnZS5jbGFzc0xldmVsUGVybWlzc2lvbnM7XG4gICAgY29uc3QgY2xhc3NOYW1lID0gZGVsZXRlZFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICBsb2dnZXIudmVyYm9zZShcbiAgICAgICdDbGFzc05hbWU6ICVqIHwgT2JqZWN0SWQ6ICVzJyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIGRlbGV0ZWRQYXJzZU9iamVjdC5pZFxuICAgICk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlciA6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICh0eXBlb2YgY2xhc3NTdWJzY3JpcHRpb25zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzICcgKyBjbGFzc05hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHN1YnNjcmlwdGlvbiBvZiBjbGFzc1N1YnNjcmlwdGlvbnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGlzU3Vic2NyaXB0aW9uTWF0Y2hlZCA9IHRoaXMuX21hdGNoZXNTdWJzY3JpcHRpb24oXG4gICAgICAgIGRlbGV0ZWRQYXJzZU9iamVjdCxcbiAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICApO1xuICAgICAgaWYgKCFpc1N1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IFtjbGllbnRJZCwgcmVxdWVzdElkc10gb2YgXy5lbnRyaWVzKFxuICAgICAgICBzdWJzY3JpcHRpb24uY2xpZW50UmVxdWVzdElkc1xuICAgICAgKSkge1xuICAgICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KGNsaWVudElkKTtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCByZXF1ZXN0SWQgb2YgcmVxdWVzdElkcykge1xuICAgICAgICAgIGNvbnN0IGFjbCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgIC8vIENoZWNrIENMUFxuICAgICAgICAgIGNvbnN0IG9wID0gdGhpcy5fZ2V0Q0xQT3BlcmF0aW9uKHN1YnNjcmlwdGlvbi5xdWVyeSk7XG4gICAgICAgICAgdGhpcy5fbWF0Y2hlc0NMUChcbiAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgY2xpZW50LFxuICAgICAgICAgICAgcmVxdWVzdElkLFxuICAgICAgICAgICAgb3BcbiAgICAgICAgICApXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIC8vIENoZWNrIEFDTFxuICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbWF0Y2hlc0FDTChhY2wsIGNsaWVudCwgcmVxdWVzdElkKTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAudGhlbihpc01hdGNoZWQgPT4ge1xuICAgICAgICAgICAgICBpZiAoIWlzTWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGNsaWVudC5wdXNoRGVsZXRlKHJlcXVlc3RJZCwgZGVsZXRlZFBhcnNlT2JqZWN0KTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICBsb2dnZXIuZXJyb3IoJ01hdGNoaW5nIEFDTCBlcnJvciA6ICcsIGVycm9yKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIgYWZ0ZXIgaW5mbGF0ZWQuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0LlxuICBfb25BZnRlclNhdmUobWVzc2FnZTogYW55KTogdm9pZCB7XG4gICAgbG9nZ2VyLnZlcmJvc2UoUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUgaXMgdHJpZ2dlcmVkJyk7XG5cbiAgICBsZXQgb3JpZ2luYWxQYXJzZU9iamVjdCA9IG51bGw7XG4gICAgaWYgKG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgICAgb3JpZ2luYWxQYXJzZU9iamVjdCA9IG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdC50b0pTT04oKTtcbiAgICB9XG4gICAgY29uc3QgY2xhc3NMZXZlbFBlcm1pc3Npb25zID0gbWVzc2FnZS5jbGFzc0xldmVsUGVybWlzc2lvbnM7XG4gICAgY29uc3QgY3VycmVudFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QudG9KU09OKCk7XG4gICAgY29uc3QgY2xhc3NOYW1lID0gY3VycmVudFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICBsb2dnZXIudmVyYm9zZShcbiAgICAgICdDbGFzc05hbWU6ICVzIHwgT2JqZWN0SWQ6ICVzJyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIGN1cnJlbnRQYXJzZU9iamVjdC5pZFxuICAgICk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlciA6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICh0eXBlb2YgY2xhc3NTdWJzY3JpcHRpb25zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzICcgKyBjbGFzc05hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHN1YnNjcmlwdGlvbiBvZiBjbGFzc1N1YnNjcmlwdGlvbnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGlzT3JpZ2luYWxTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihcbiAgICAgICAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICApO1xuICAgICAgY29uc3QgaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZCA9IHRoaXMuX21hdGNoZXNTdWJzY3JpcHRpb24oXG4gICAgICAgIGN1cnJlbnRQYXJzZU9iamVjdCxcbiAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICApO1xuICAgICAgZm9yIChjb25zdCBbY2xpZW50SWQsIHJlcXVlc3RJZHNdIG9mIF8uZW50cmllcyhcbiAgICAgICAgc3Vic2NyaXB0aW9uLmNsaWVudFJlcXVlc3RJZHNcbiAgICAgICkpIHtcbiAgICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChjbGllbnRJZCk7XG4gICAgICAgIGlmICh0eXBlb2YgY2xpZW50ID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgcmVxdWVzdElkIG9mIHJlcXVlc3RJZHMpIHtcbiAgICAgICAgICAvLyBTZXQgb3JpZ25hbCBQYXJzZU9iamVjdCBBQ0wgY2hlY2tpbmcgcHJvbWlzZSwgaWYgdGhlIG9iamVjdCBkb2VzIG5vdCBtYXRjaFxuICAgICAgICAgIC8vIHN1YnNjcmlwdGlvbiwgd2UgZG8gbm90IG5lZWQgdG8gY2hlY2sgQUNMXG4gICAgICAgICAgbGV0IG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlO1xuICAgICAgICAgIGlmICghaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IG9yaWdpbmFsQUNMO1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgICAgICAgICAgICBvcmlnaW5hbEFDTCA9IG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdC5nZXRBQ0woKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlID0gdGhpcy5fbWF0Y2hlc0FDTChcbiAgICAgICAgICAgICAgb3JpZ2luYWxBQ0wsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBTZXQgY3VycmVudCBQYXJzZU9iamVjdCBBQ0wgY2hlY2tpbmcgcHJvbWlzZSwgaWYgdGhlIG9iamVjdCBkb2VzIG5vdCBtYXRjaFxuICAgICAgICAgIC8vIHN1YnNjcmlwdGlvbiwgd2UgZG8gbm90IG5lZWQgdG8gY2hlY2sgQUNMXG4gICAgICAgICAgbGV0IGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2U7XG4gICAgICAgICAgaWYgKCFpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkKSB7XG4gICAgICAgICAgICBjdXJyZW50QUNMQ2hlY2tpbmdQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgY3VycmVudEFDTCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgICAgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSA9IHRoaXMuX21hdGNoZXNBQ0woXG4gICAgICAgICAgICAgIGN1cnJlbnRBQ0wsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBvcCA9IHRoaXMuX2dldENMUE9wZXJhdGlvbihzdWJzY3JpcHRpb24ucXVlcnkpO1xuICAgICAgICAgIHRoaXMuX21hdGNoZXNDTFAoXG4gICAgICAgICAgICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICAgICAgICBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCxcbiAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgIHJlcXVlc3RJZCxcbiAgICAgICAgICAgIG9wXG4gICAgICAgICAgKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwoW1xuICAgICAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlLFxuICAgICAgICAgICAgICAgIGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2UsXG4gICAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC50aGVuKFxuICAgICAgICAgICAgICAoW2lzT3JpZ2luYWxNYXRjaGVkLCBpc0N1cnJlbnRNYXRjaGVkXSkgPT4ge1xuICAgICAgICAgICAgICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgICAgICAgICAgICAgJ09yaWdpbmFsICVqIHwgQ3VycmVudCAlaiB8IE1hdGNoOiAlcywgJXMsICVzLCAlcyB8IFF1ZXJ5OiAlcycsXG4gICAgICAgICAgICAgICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQsXG4gICAgICAgICAgICAgICAgICBpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkLFxuICAgICAgICAgICAgICAgICAgaXNPcmlnaW5hbE1hdGNoZWQsXG4gICAgICAgICAgICAgICAgICBpc0N1cnJlbnRNYXRjaGVkLFxuICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uLmhhc2hcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgLy8gRGVjaWRlIGV2ZW50IHR5cGVcbiAgICAgICAgICAgICAgICBsZXQgdHlwZTtcbiAgICAgICAgICAgICAgICBpZiAoaXNPcmlnaW5hbE1hdGNoZWQgJiYgaXNDdXJyZW50TWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgICAgdHlwZSA9ICdVcGRhdGUnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaXNPcmlnaW5hbE1hdGNoZWQgJiYgIWlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICAgIHR5cGUgPSAnTGVhdmUnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIWlzT3JpZ2luYWxNYXRjaGVkICYmIGlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICAgIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGUgPSAnRW50ZXInO1xuICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZSA9ICdDcmVhdGUnO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCBmdW5jdGlvbk5hbWUgPSAncHVzaCcgKyB0eXBlO1xuXG4gICAgICAgICAgICBjb25zdCBzc1Rva2VuID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKS5zZXNzaW9uVG9rZW47XG4gICAgICAgICAgICB0aGlzLnNlc3Npb25Ub2tlbkNhY2hlLmdldFVzZXJJZChzc1Rva2VuKS50aGVuKHVzZXJJZCA9PiB7XG4gICAgICAgICAgICAgIHJldHVybiB0aGlzLmNhY2hlQ29udHJvbGxlci5yb2xlLmdldChzc1Rva2VuKS50aGVuKGNVc2VyID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoY1VzZXIpIHJldHVybiBjVXNlcjtcbiAgICAgICAgICAgICAgICByZXR1cm4gKG5ldyBQYXJzZS5RdWVyeShQYXJzZS5Vc2VyKSkuZXF1YWxUbyhcIm9iamVjdElkXCIsIHVzZXJJZCkubGltaXQoMTAwMDApLmZpbmQoe3VzZU1hc3RlcktleTp0cnVlfSkudGhlbih1c2VyID0+IHtcbiAgICAgICAgICAgICAgICAgIGlmICghdXNlciB8fCAhdXNlci5sZW5ndGgpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgICB0aGlzLmNhY2hlQ29udHJvbGxlci5yb2xlLnB1dChzc1Rva2VuLCB1c2VyWzBdKTtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KHVzZXJbMF0pKTtcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfSkudGhlbih1c2VyID0+IHtcbiAgICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGN1cnJlbnRQYXJzZU9iamVjdDtcbiAgICAgICAgICAgICAgKHRoaXMucXVlcnlNaWRkbGV3YXJlIHx8IFtdKS5mb3JFYWNoKHdhcmUgPT4gcmVzdWx0ID0gd2FyZShyZXN1bHQuY2xhc3NOYW1lLCBbcmVzdWx0XSwge3VzZXI6IHtnZXRUZWFtczogKCkgPT4gdXNlci50ZWFtc319KVswXSlcbiAgICAgICAgICAgICAgY2xpZW50W2Z1bmN0aW9uTmFtZV0ocmVxdWVzdElkLCByZXN1bHQpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICB9LCAoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGxvZ2dlci5lcnJvcignTWF0Y2hpbmcgQUNMIGVycm9yIDogJywgZXJyb3IpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgX29uQ29ubmVjdChwYXJzZVdlYnNvY2tldDogYW55KTogdm9pZCB7XG4gICAgcGFyc2VXZWJzb2NrZXQub24oJ21lc3NhZ2UnLCByZXF1ZXN0ID0+IHtcbiAgICAgIGlmICh0eXBlb2YgcmVxdWVzdCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXF1ZXN0ID0gSlNPTi5wYXJzZShyZXF1ZXN0KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIGxvZ2dlci5lcnJvcigndW5hYmxlIHRvIHBhcnNlIHJlcXVlc3QnLCByZXF1ZXN0LCBlKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGxvZ2dlci52ZXJib3NlKCdSZXF1ZXN0OiAlaicsIHJlcXVlc3QpO1xuXG4gICAgICAvLyBDaGVjayB3aGV0aGVyIHRoaXMgcmVxdWVzdCBpcyBhIHZhbGlkIHJlcXVlc3QsIHJldHVybiBlcnJvciBkaXJlY3RseSBpZiBub3RcbiAgICAgIGlmIChcbiAgICAgICAgIXR2NC52YWxpZGF0ZShyZXF1ZXN0LCBSZXF1ZXN0U2NoZW1hWydnZW5lcmFsJ10pIHx8XG4gICAgICAgICF0djQudmFsaWRhdGUocmVxdWVzdCwgUmVxdWVzdFNjaGVtYVtyZXF1ZXN0Lm9wXSlcbiAgICAgICkge1xuICAgICAgICBDbGllbnQucHVzaEVycm9yKHBhcnNlV2Vic29ja2V0LCAxLCB0djQuZXJyb3IubWVzc2FnZSk7XG4gICAgICAgIGxvZ2dlci5lcnJvcignQ29ubmVjdCBtZXNzYWdlIGVycm9yICVzJywgdHY0LmVycm9yLm1lc3NhZ2UpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHN3aXRjaCAocmVxdWVzdC5vcCkge1xuICAgICAgICBjYXNlICdjb25uZWN0JzpcbiAgICAgICAgICB0aGlzLl9oYW5kbGVDb25uZWN0KHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnc3Vic2NyaWJlJzpcbiAgICAgICAgICB0aGlzLl9oYW5kbGVTdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICd1cGRhdGUnOlxuICAgICAgICAgIHRoaXMuX2hhbmRsZVVwZGF0ZVN1YnNjcmlwdGlvbihwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ3Vuc3Vic2NyaWJlJzpcbiAgICAgICAgICB0aGlzLl9oYW5kbGVVbnN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgMywgJ0dldCB1bmtub3duIG9wZXJhdGlvbicpO1xuICAgICAgICAgIGxvZ2dlci5lcnJvcignR2V0IHVua25vd24gb3BlcmF0aW9uJywgcmVxdWVzdC5vcCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBwYXJzZVdlYnNvY2tldC5vbignZGlzY29ubmVjdCcsICgpID0+IHtcbiAgICAgIGxvZ2dlci5pbmZvKGBDbGllbnQgZGlzY29ubmVjdDogJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH1gKTtcbiAgICAgIGNvbnN0IGNsaWVudElkID0gcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQ7XG4gICAgICBpZiAoIXRoaXMuY2xpZW50cy5oYXMoY2xpZW50SWQpKSB7XG4gICAgICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgICAgIGV2ZW50OiAnd3NfZGlzY29ubmVjdF9lcnJvcicsXG4gICAgICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgICAgICAgZXJyb3I6IGBVbmFibGUgdG8gZmluZCBjbGllbnQgJHtjbGllbnRJZH1gLFxuICAgICAgICB9KTtcbiAgICAgICAgbG9nZ2VyLmVycm9yKGBDYW4gbm90IGZpbmQgY2xpZW50ICR7Y2xpZW50SWR9IG9uIGRpc2Nvbm5lY3RgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBEZWxldGUgY2xpZW50XG4gICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KGNsaWVudElkKTtcbiAgICAgIHRoaXMuY2xpZW50cy5kZWxldGUoY2xpZW50SWQpO1xuXG4gICAgICAvLyBEZWxldGUgY2xpZW50IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgICAgZm9yIChjb25zdCBbcmVxdWVzdElkLCBzdWJzY3JpcHRpb25JbmZvXSBvZiBfLmVudHJpZXMoXG4gICAgICAgIGNsaWVudC5zdWJzY3JpcHRpb25JbmZvc1xuICAgICAgKSkge1xuICAgICAgICBjb25zdCBzdWJzY3JpcHRpb24gPSBzdWJzY3JpcHRpb25JbmZvLnN1YnNjcmlwdGlvbjtcbiAgICAgICAgc3Vic2NyaXB0aW9uLmRlbGV0ZUNsaWVudFN1YnNjcmlwdGlvbihjbGllbnRJZCwgcmVxdWVzdElkKTtcblxuICAgICAgICAvLyBJZiB0aGVyZSBpcyBubyBjbGllbnQgd2hpY2ggaXMgc3Vic2NyaWJpbmcgdGhpcyBzdWJzY3JpcHRpb24sIHJlbW92ZSBpdCBmcm9tIHN1YnNjcmlwdGlvbnNcbiAgICAgICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChcbiAgICAgICAgICBzdWJzY3JpcHRpb24uY2xhc3NOYW1lXG4gICAgICAgICk7XG4gICAgICAgIGlmICghc3Vic2NyaXB0aW9uLmhhc1N1YnNjcmliaW5nQ2xpZW50KCkpIHtcbiAgICAgICAgICBjbGFzc1N1YnNjcmlwdGlvbnMuZGVsZXRlKHN1YnNjcmlwdGlvbi5oYXNoKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBJZiB0aGVyZSBpcyBubyBzdWJzY3JpcHRpb25zIHVuZGVyIHRoaXMgY2xhc3MsIHJlbW92ZSBpdCBmcm9tIHN1YnNjcmlwdGlvbnNcbiAgICAgICAgaWYgKGNsYXNzU3Vic2NyaXB0aW9ucy5zaXplID09PSAwKSB7XG4gICAgICAgICAgdGhpcy5zdWJzY3JpcHRpb25zLmRlbGV0ZShzdWJzY3JpcHRpb24uY2xhc3NOYW1lKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBjbGllbnRzICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgc3Vic2NyaXB0aW9ucyAlZCcsIHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplKTtcbiAgICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgICBldmVudDogJ3dzX2Rpc2Nvbm5lY3QnLFxuICAgICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgZXZlbnQ6ICd3c19jb25uZWN0JyxcbiAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgfSk7XG4gIH1cblxuICBfbWF0Y2hlc1N1YnNjcmlwdGlvbihwYXJzZU9iamVjdDogYW55LCBzdWJzY3JpcHRpb246IGFueSk6IGJvb2xlYW4ge1xuICAgIC8vIE9iamVjdCBpcyB1bmRlZmluZWQgb3IgbnVsbCwgbm90IG1hdGNoXG4gICAgaWYgKCFwYXJzZU9iamVjdCkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gbWF0Y2hlc1F1ZXJ5KHBhcnNlT2JqZWN0LCBzdWJzY3JpcHRpb24ucXVlcnkpO1xuICB9XG5cbiAgZ2V0QXV0aEZvclNlc3Npb25Ub2tlbihcbiAgICBzZXNzaW9uVG9rZW46ID9zdHJpbmdcbiAgKTogUHJvbWlzZTx7IGF1dGg6ID9BdXRoLCB1c2VySWQ6ID9zdHJpbmcgfT4ge1xuICAgIGlmICghc2Vzc2lvblRva2VuKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgICB9XG4gICAgY29uc3QgZnJvbUNhY2hlID0gdGhpcy5hdXRoQ2FjaGUuZ2V0KHNlc3Npb25Ub2tlbik7XG4gICAgaWYgKGZyb21DYWNoZSkge1xuICAgICAgcmV0dXJuIGZyb21DYWNoZTtcbiAgICB9XG4gICAgY29uc3QgYXV0aFByb21pc2UgPSBnZXRBdXRoRm9yU2Vzc2lvblRva2VuKHtcbiAgICAgIGNhY2hlQ29udHJvbGxlcjogdGhpcy5jYWNoZUNvbnRyb2xsZXIsXG4gICAgICBzZXNzaW9uVG9rZW46IHNlc3Npb25Ub2tlbixcbiAgICB9KVxuICAgICAgLnRoZW4oYXV0aCA9PiB7XG4gICAgICAgIHJldHVybiB7IGF1dGgsIHVzZXJJZDogYXV0aCAmJiBhdXRoLnVzZXIgJiYgYXV0aC51c2VyLmlkIH07XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgLy8gVGhlcmUgd2FzIGFuIGVycm9yIHdpdGggdGhlIHNlc3Npb24gdG9rZW5cbiAgICAgICAgY29uc3QgcmVzdWx0ID0ge307XG4gICAgICAgIGlmIChlcnJvciAmJiBlcnJvci5jb2RlID09PSBQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4pIHtcbiAgICAgICAgICAvLyBTdG9yZSBhIHJlc29sdmVkIHByb21pc2Ugd2l0aCB0aGUgZXJyb3IgZm9yIDEwIG1pbnV0ZXNcbiAgICAgICAgICByZXN1bHQuZXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICB0aGlzLmF1dGhDYWNoZS5zZXQoXG4gICAgICAgICAgICBzZXNzaW9uVG9rZW4sXG4gICAgICAgICAgICBQcm9taXNlLnJlc29sdmUocmVzdWx0KSxcbiAgICAgICAgICAgIDYwICogMTAgKiAxMDAwXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aGlzLmF1dGhDYWNoZS5kZWwoc2Vzc2lvblRva2VuKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgfSk7XG4gICAgdGhpcy5hdXRoQ2FjaGUuc2V0KHNlc3Npb25Ub2tlbiwgYXV0aFByb21pc2UpO1xuICAgIHJldHVybiBhdXRoUHJvbWlzZTtcbiAgfVxuXG4gIGFzeW5jIF9tYXRjaGVzQ0xQKFxuICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9uczogP2FueSxcbiAgICBvYmplY3Q6IGFueSxcbiAgICBjbGllbnQ6IGFueSxcbiAgICByZXF1ZXN0SWQ6IG51bWJlcixcbiAgICBvcDogc3RyaW5nXG4gICk6IGFueSB7XG4gICAgLy8gdHJ5IHRvIG1hdGNoIG9uIHVzZXIgZmlyc3QsIGxlc3MgZXhwZW5zaXZlIHRoYW4gd2l0aCByb2xlc1xuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm8gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIGNvbnN0IGFjbEdyb3VwID0gWycqJ107XG4gICAgbGV0IHVzZXJJZDtcbiAgICBpZiAodHlwZW9mIHN1YnNjcmlwdGlvbkluZm8gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBjb25zdCB7IHVzZXJJZCB9ID0gYXdhaXQgdGhpcy5nZXRBdXRoRm9yU2Vzc2lvblRva2VuKFxuICAgICAgICBzdWJzY3JpcHRpb25JbmZvLnNlc3Npb25Ub2tlblxuICAgICAgKTtcbiAgICAgIGlmICh1c2VySWQpIHtcbiAgICAgICAgYWNsR3JvdXAucHVzaCh1c2VySWQpO1xuICAgICAgfVxuICAgIH1cbiAgICB0cnkge1xuICAgICAgYXdhaXQgU2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oXG4gICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgb2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgYWNsR3JvdXAsXG4gICAgICAgIG9wXG4gICAgICApO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nZ2VyLnZlcmJvc2UoYEZhaWxlZCBtYXRjaGluZyBDTFAgZm9yICR7b2JqZWN0LmlkfSAke3VzZXJJZH0gJHtlfWApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICAvLyBUT0RPOiBoYW5kbGUgcm9sZXMgcGVybWlzc2lvbnNcbiAgICAvLyBPYmplY3Qua2V5cyhjbGFzc0xldmVsUGVybWlzc2lvbnMpLmZvckVhY2goKGtleSkgPT4ge1xuICAgIC8vICAgY29uc3QgcGVybSA9IGNsYXNzTGV2ZWxQZXJtaXNzaW9uc1trZXldO1xuICAgIC8vICAgT2JqZWN0LmtleXMocGVybSkuZm9yRWFjaCgoa2V5KSA9PiB7XG4gICAgLy8gICAgIGlmIChrZXkuaW5kZXhPZigncm9sZScpKVxuICAgIC8vICAgfSk7XG4gICAgLy8gfSlcbiAgICAvLyAvLyBpdCdzIHJlamVjdGVkIGhlcmUsIGNoZWNrIHRoZSByb2xlc1xuICAgIC8vIHZhciByb2xlc1F1ZXJ5ID0gbmV3IFBhcnNlLlF1ZXJ5KFBhcnNlLlJvbGUpO1xuICAgIC8vIHJvbGVzUXVlcnkuZXF1YWxUbyhcInVzZXJzXCIsIHVzZXIpO1xuICAgIC8vIHJldHVybiByb2xlc1F1ZXJ5LmZpbmQoe3VzZU1hc3RlcktleTp0cnVlfSk7XG4gIH1cblxuICBfZ2V0Q0xQT3BlcmF0aW9uKHF1ZXJ5OiBhbnkpIHtcbiAgICByZXR1cm4gdHlwZW9mIHF1ZXJ5ID09PSAnb2JqZWN0JyAmJlxuICAgICAgT2JqZWN0LmtleXMocXVlcnkpLmxlbmd0aCA9PSAxICYmXG4gICAgICB0eXBlb2YgcXVlcnkub2JqZWN0SWQgPT09ICdzdHJpbmcnXG4gICAgICA/ICdnZXQnXG4gICAgICA6ICdmaW5kJztcbiAgfVxuXG4gIGFzeW5jIF92ZXJpZnlBQ0woYWNsOiBhbnksIHRva2VuOiBzdHJpbmcpIHtcbiAgICBpZiAoIXRva2VuKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgY29uc3QgeyBhdXRoLCB1c2VySWQgfSA9IGF3YWl0IHRoaXMuZ2V0QXV0aEZvclNlc3Npb25Ub2tlbih0b2tlbik7XG5cbiAgICAvLyBHZXR0aW5nIHRoZSBzZXNzaW9uIHRva2VuIGZhaWxlZFxuICAgIC8vIFRoaXMgbWVhbnMgdGhhdCBubyBhZGRpdGlvbmFsIGF1dGggaXMgYXZhaWxhYmxlXG4gICAgLy8gQXQgdGhpcyBwb2ludCwganVzdCBiYWlsIG91dCBhcyBubyBhZGRpdGlvbmFsIHZpc2liaWxpdHkgY2FuIGJlIGluZmVycmVkLlxuICAgIGlmICghYXV0aCB8fCAhdXNlcklkKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IGlzU3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuTWF0Y2hlZCA9IGFjbC5nZXRSZWFkQWNjZXNzKHVzZXJJZCk7XG4gICAgaWYgKGlzU3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuTWF0Y2hlZCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgaWYgdGhlIHVzZXIgaGFzIGFueSByb2xlcyB0aGF0IG1hdGNoIHRoZSBBQ0xcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgLy8gUmVzb2x2ZSBmYWxzZSByaWdodCBhd2F5IGlmIHRoZSBhY2wgZG9lc24ndCBoYXZlIGFueSByb2xlc1xuICAgICAgICBjb25zdCBhY2xfaGFzX3JvbGVzID0gT2JqZWN0LmtleXMoYWNsLnBlcm1pc3Npb25zQnlJZCkuc29tZShrZXkgPT5cbiAgICAgICAgICBrZXkuc3RhcnRzV2l0aCgncm9sZTonKVxuICAgICAgICApO1xuICAgICAgICBpZiAoIWFjbF9oYXNfcm9sZXMpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zZXNzaW9uVG9rZW5DYWNoZS5nZXRVc2VySWQoc3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuKVxuICAgICAgICAudGhlbigodXNlcklkKSA9PiB7XG4gICAgICAgICAgICAvLyBQYXNzIGFsb25nIGEgbnVsbCBpZiB0aGVyZSBpcyBubyB1c2VyIGlkXG4gICAgICAgICAgaWYgKCF1c2VySWQpIHtcbiAgICAgICAgICAgIHJldHVybiBQYXJzZS5Qcm9taXNlLmFzKG51bGwpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB2YXIgdXNlciA9IG5ldyBQYXJzZS5Vc2VyKCk7XG4gICAgICAgICAgdXNlci5pZCA9IHVzZXJJZDtcbiAgICAgICAgICByZXR1cm4gdXNlcjtcblxuICAgICAgICB9KVxuICAgICAgICAudGhlbih1c2VyID0+IHtcbiAgICAgICAgICAvLyBQYXNzIGFsb25nIGFuIGVtcHR5IGFycmF5IChvZiByb2xlcykgaWYgbm8gdXNlclxuICAgICAgICAgIGlmICghdXNlcikge1xuICAgICAgICAgICAgcmV0dXJuIFBhcnNlLlByb21pc2UuYXMoW10pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmICh0aGlzLmNhY2hlQ29udHJvbGxlclxuICAgICAgICAgICAgJiYgdGhpcy5jYWNoZUNvbnRyb2xsZXIuYWRhcHRlclxuICAgICAgICAgICAgJiYgdGhpcy5jYWNoZUNvbnRyb2xsZXIuYWRhcHRlciBpbnN0YW5jZW9mIFJlZGlzQ2FjaGVBZGFwdGVyKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jYWNoZUNvbnRyb2xsZXIucm9sZS5nZXQodXNlci5pZCkudGhlbihyb2xlcyA9PiB7XG4gICAgICAgICAgICAgIGlmIChyb2xlcyAhPSBudWxsKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ0xpdmVRdWVyeTogdXNpbmcgcm9sZXMgZnJvbSBjYWNoZSBmb3IgdXNlciAnICsgdXNlci5pZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvbGVzLm1hcChyb2xlID0+IHJvbGUucmVwbGFjZSgvXnJvbGU6LywgJycpKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBjb25zb2xlLmxvZygnTGl2ZVF1ZXJ5OiBsb2FkaW5nIHJvbGVzIGZyb20gZGF0YWJhc2UgYXMgdGhleVxcJ3JlIG5vdCBjYWNoZWQgZm9yIHVzZXIgJyArIHVzZXIuaWQpO1xuICAgICAgICAgICAgICByZXR1cm4gdGhpcy5sb2FkUm9sZXNEZWxlZ2F0ZSh1c2VyLCB0aGlzLmNhY2hlQ29udHJvbGxlcikudGhlbihyb2xlcyA9PiB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYExpdmVRdWVyeTogdXNlcjogJHt1c2VyLmlkfWxvYWRlZCByb2xlczpgICsgcm9sZXMpO1xuICAgICAgICAgICAgICAgIHRoaXMuY2FjaGVDb250cm9sbGVyLnJvbGUucHV0KHVzZXIuaWQsIHJvbGVzLm1hcChyb2xlID0+ICdyb2xlOicgKyByb2xlKSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvbGVzO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBlbHNlIHsgLy8gZmFsbGJhY2sgdG8gZGlyZWN0IHF1ZXJ5XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnTGl2ZVF1ZXJ5OiBmYWxsYmFjazogbG9hZGluZyByb2xlcyBmcm9tIGRhdGFiYXNlIGZvciB1c2VyICcgKyB1c2VyLmlkKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmxvYWRSb2xlc0RlbGVnYXRlKHVzZXIsIHRoaXMuY2FjaGVDb250cm9sbGVyKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pLlxuICAgICAgICB0aGVuKHJvbGVzID0+IHtcbiAgICAgICAgICAvLyBGaW5hbGx5LCBzZWUgaWYgYW55IG9mIHRoZSB1c2VyJ3Mgcm9sZXMgYWxsb3cgdGhlbSByZWFkIGFjY2Vzc1xuICAgICAgICAgIHJldHVybiAhIX5yb2xlcy5maW5kSW5kZXgocm9sZSA9PiBhY2wuZ2V0Um9sZVJlYWRBY2Nlc3Mocm9sZSkpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgY29uc29sZS5sb2coJ0xpdmVRdWVyeTogZXJyb3I6JywgZXJyb3IpO1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSk7XG5cbiAgICAgIH0pO1xuXG4gIH1cblxuICBhc3luYyBfbWF0Y2hlc0FDTChcbiAgICBhY2w6IGFueSxcbiAgICBjbGllbnQ6IGFueSxcbiAgICByZXF1ZXN0SWQ6IG51bWJlclxuICApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICAvLyBSZXR1cm4gdHJ1ZSBkaXJlY3RseSBpZiBBQ0wgaXNuJ3QgcHJlc2VudCwgQUNMIGlzIHB1YmxpYyByZWFkLCBvciBjbGllbnQgaGFzIG1hc3RlciBrZXlcbiAgICBpZiAoIWFjbCB8fCBhY2wuZ2V0UHVibGljUmVhZEFjY2VzcygpIHx8IGNsaWVudC5oYXNNYXN0ZXJLZXkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICAvLyBDaGVjayBzdWJzY3JpcHRpb24gc2Vzc2lvblRva2VuIG1hdGNoZXMgQUNMIGZpcnN0XG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IGNsaWVudC5nZXRTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgaWYgKHR5cGVvZiBzdWJzY3JpcHRpb25JbmZvID09PSAndW5kZWZpbmVkJykge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIGNvbnN0IHN1YnNjcmlwdGlvblRva2VuID0gc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW47XG4gICAgY29uc3QgY2xpZW50U2Vzc2lvblRva2VuID0gY2xpZW50LnNlc3Npb25Ub2tlbjtcblxuICAgIGlmIChhd2FpdCB0aGlzLl92ZXJpZnlBQ0woYWNsLCBzdWJzY3JpcHRpb25Ub2tlbikpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGlmIChhd2FpdCB0aGlzLl92ZXJpZnlBQ0woYWNsLCBjbGllbnRTZXNzaW9uVG9rZW4pKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgX2hhbmRsZUNvbm5lY3QocGFyc2VXZWJzb2NrZXQ6IGFueSwgcmVxdWVzdDogYW55KTogYW55IHtcbiAgICBpZiAoIXRoaXMuX3ZhbGlkYXRlS2V5cyhyZXF1ZXN0LCB0aGlzLmtleVBhaXJzKSkge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgNCwgJ0tleSBpbiByZXF1ZXN0IGlzIG5vdCB2YWxpZCcpO1xuICAgICAgbG9nZ2VyLmVycm9yKCdLZXkgaW4gcmVxdWVzdCBpcyBub3QgdmFsaWQnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgaGFzTWFzdGVyS2V5ID0gdGhpcy5faGFzTWFzdGVyS2V5KHJlcXVlc3QsIHRoaXMua2V5UGFpcnMpO1xuICAgIGNvbnN0IGNsaWVudElkID0gdXVpZCgpO1xuICAgIGNvbnN0IGNsaWVudCA9IG5ldyBDbGllbnQoY2xpZW50SWQsIHBhcnNlV2Vic29ja2V0LCBoYXNNYXN0ZXJLZXkpO1xuICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkID0gY2xpZW50SWQ7XG4gICAgdGhpcy5jbGllbnRzLnNldChwYXJzZVdlYnNvY2tldC5jbGllbnRJZCwgY2xpZW50KTtcbiAgICBsb2dnZXIuaW5mbyhgQ3JlYXRlIG5ldyBjbGllbnQ6ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9YCk7XG4gICAgY2xpZW50LnB1c2hDb25uZWN0KCk7XG4gICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICBldmVudDogJ2Nvbm5lY3QnLFxuICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICB9KTtcbiAgfVxuXG4gIF9oYXNNYXN0ZXJLZXkocmVxdWVzdDogYW55LCB2YWxpZEtleVBhaXJzOiBhbnkpOiBib29sZWFuIHtcbiAgICBpZiAoXG4gICAgICAhdmFsaWRLZXlQYWlycyB8fFxuICAgICAgdmFsaWRLZXlQYWlycy5zaXplID09IDAgfHxcbiAgICAgICF2YWxpZEtleVBhaXJzLmhhcygnbWFzdGVyS2V5JylcbiAgICApIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKCFyZXF1ZXN0IHx8ICFyZXF1ZXN0Lmhhc093blByb3BlcnR5KCdtYXN0ZXJLZXknKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gcmVxdWVzdC5tYXN0ZXJLZXkgPT09IHZhbGlkS2V5UGFpcnMuZ2V0KCdtYXN0ZXJLZXknKTtcbiAgfVxuXG4gIF92YWxpZGF0ZUtleXMocmVxdWVzdDogYW55LCB2YWxpZEtleVBhaXJzOiBhbnkpOiBib29sZWFuIHtcbiAgICBpZiAoIXZhbGlkS2V5UGFpcnMgfHwgdmFsaWRLZXlQYWlycy5zaXplID09IDApIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBsZXQgaXNWYWxpZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgW2tleSwgc2VjcmV0XSBvZiB2YWxpZEtleVBhaXJzKSB7XG4gICAgICBpZiAoIXJlcXVlc3Rba2V5XSB8fCByZXF1ZXN0W2tleV0gIT09IHNlY3JldCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlzVmFsaWQgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiBpc1ZhbGlkO1xuICB9XG5cbiAgX2hhbmRsZVN1YnNjcmliZShwYXJzZVdlYnNvY2tldDogYW55LCByZXF1ZXN0OiBhbnkpOiBhbnkge1xuICAgIC8vIElmIHdlIGNhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgcmV0dXJuIGVycm9yIHRvIGNsaWVudFxuICAgIGlmICghcGFyc2VXZWJzb2NrZXQuaGFzT3duUHJvcGVydHkoJ2NsaWVudElkJykpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCBtYWtlIHN1cmUgeW91IGNvbm5lY3QgdG8gc2VydmVyIGJlZm9yZSBzdWJzY3JpYmluZydcbiAgICAgICk7XG4gICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHN1YnNjcmliaW5nJ1xuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChwYXJzZVdlYnNvY2tldC5jbGllbnRJZCk7XG5cbiAgICAvLyBHZXQgc3Vic2NyaXB0aW9uIGZyb20gc3Vic2NyaXB0aW9ucywgY3JlYXRlIG9uZSBpZiBuZWNlc3NhcnlcbiAgICBjb25zdCBzdWJzY3JpcHRpb25IYXNoID0gcXVlcnlIYXNoKHJlcXVlc3QucXVlcnkpO1xuICAgIC8vIEFkZCBjbGFzc05hbWUgdG8gc3Vic2NyaXB0aW9ucyBpZiBuZWNlc3NhcnlcbiAgICBjb25zdCBjbGFzc05hbWUgPSByZXF1ZXN0LnF1ZXJ5LmNsYXNzTmFtZTtcbiAgICBpZiAoIXRoaXMuc3Vic2NyaXB0aW9ucy5oYXMoY2xhc3NOYW1lKSkge1xuICAgICAgdGhpcy5zdWJzY3JpcHRpb25zLnNldChjbGFzc05hbWUsIG5ldyBNYXAoKSk7XG4gICAgfVxuICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoY2xhc3NOYW1lKTtcbiAgICBsZXQgc3Vic2NyaXB0aW9uO1xuICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMuaGFzKHN1YnNjcmlwdGlvbkhhc2gpKSB7XG4gICAgICBzdWJzY3JpcHRpb24gPSBjbGFzc1N1YnNjcmlwdGlvbnMuZ2V0KHN1YnNjcmlwdGlvbkhhc2gpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzdWJzY3JpcHRpb24gPSBuZXcgU3Vic2NyaXB0aW9uKFxuICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgIHJlcXVlc3QucXVlcnkud2hlcmUsXG4gICAgICAgIHN1YnNjcmlwdGlvbkhhc2hcbiAgICAgICk7XG4gICAgICBjbGFzc1N1YnNjcmlwdGlvbnMuc2V0KHN1YnNjcmlwdGlvbkhhc2gsIHN1YnNjcmlwdGlvbik7XG4gICAgfVxuXG4gICAgLy8gQWRkIHN1YnNjcmlwdGlvbkluZm8gdG8gY2xpZW50XG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IHtcbiAgICAgIHN1YnNjcmlwdGlvbjogc3Vic2NyaXB0aW9uLFxuICAgIH07XG4gICAgLy8gQWRkIHNlbGVjdGVkIGZpZWxkcyBhbmQgc2Vzc2lvblRva2VuIGZvciB0aGlzIHN1YnNjcmlwdGlvbiBpZiBuZWNlc3NhcnlcbiAgICBpZiAocmVxdWVzdC5xdWVyeS5maWVsZHMpIHtcbiAgICAgIHN1YnNjcmlwdGlvbkluZm8uZmllbGRzID0gcmVxdWVzdC5xdWVyeS5maWVsZHM7XG4gICAgfVxuICAgIGlmIChyZXF1ZXN0LnNlc3Npb25Ub2tlbikge1xuICAgICAgc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW4gPSByZXF1ZXN0LnNlc3Npb25Ub2tlbjtcbiAgICB9XG4gICAgY2xpZW50LmFkZFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdC5yZXF1ZXN0SWQsIHN1YnNjcmlwdGlvbkluZm8pO1xuXG4gICAgLy8gQWRkIGNsaWVudElkIHRvIHN1YnNjcmlwdGlvblxuICAgIHN1YnNjcmlwdGlvbi5hZGRDbGllbnRTdWJzY3JpcHRpb24oXG4gICAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCxcbiAgICAgIHJlcXVlc3QucmVxdWVzdElkXG4gICAgKTtcblxuICAgIGNsaWVudC5wdXNoU3Vic2NyaWJlKHJlcXVlc3QucmVxdWVzdElkKTtcblxuICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgYENyZWF0ZSBjbGllbnQgJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH0gbmV3IHN1YnNjcmlwdGlvbjogJHtcbiAgICAgICAgcmVxdWVzdC5yZXF1ZXN0SWRcbiAgICAgIH1gXG4gICAgKTtcbiAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBjbGllbnQgbnVtYmVyOiAlZCcsIHRoaXMuY2xpZW50cy5zaXplKTtcbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGV2ZW50OiAnc3Vic2NyaWJlJyxcbiAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgfSk7XG4gIH1cblxuICBfaGFuZGxlVXBkYXRlU3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0OiBhbnksIHJlcXVlc3Q6IGFueSk6IGFueSB7XG4gICAgdGhpcy5faGFuZGxlVW5zdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QsIGZhbHNlKTtcbiAgICB0aGlzLl9oYW5kbGVTdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICB9XG5cbiAgX2hhbmRsZVVuc3Vic2NyaWJlKFxuICAgIHBhcnNlV2Vic29ja2V0OiBhbnksXG4gICAgcmVxdWVzdDogYW55LFxuICAgIG5vdGlmeUNsaWVudDogYm9vbGVhbiA9IHRydWVcbiAgKTogYW55IHtcbiAgICAvLyBJZiB3ZSBjYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIHJldHVybiBlcnJvciB0byBjbGllbnRcbiAgICBpZiAoIXBhcnNlV2Vic29ja2V0Lmhhc093blByb3BlcnR5KCdjbGllbnRJZCcpKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKFxuICAgICAgICBwYXJzZVdlYnNvY2tldCxcbiAgICAgICAgMixcbiAgICAgICAgJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZydcbiAgICAgICk7XG4gICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHVuc3Vic2NyaWJpbmcnXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZXF1ZXN0SWQgPSByZXF1ZXN0LnJlcXVlc3RJZDtcbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KHBhcnNlV2Vic29ja2V0LmNsaWVudElkKTtcbiAgICBpZiAodHlwZW9mIGNsaWVudCA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2Fubm90IGZpbmQgY2xpZW50IHdpdGggY2xpZW50SWQgJyArXG4gICAgICAgICAgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgK1xuICAgICAgICAgICcuIE1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBsaXZlIHF1ZXJ5IHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZy4nXG4gICAgICApO1xuICAgICAgbG9nZ2VyLmVycm9yKCdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQgJyArIHBhcnNlV2Vic29ja2V0LmNsaWVudElkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICBpZiAodHlwZW9mIHN1YnNjcmlwdGlvbkluZm8gPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKFxuICAgICAgICBwYXJzZVdlYnNvY2tldCxcbiAgICAgICAgMixcbiAgICAgICAgJ0Nhbm5vdCBmaW5kIHN1YnNjcmlwdGlvbiB3aXRoIGNsaWVudElkICcgK1xuICAgICAgICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkICtcbiAgICAgICAgICAnIHN1YnNjcmlwdGlvbklkICcgK1xuICAgICAgICAgIHJlcXVlc3RJZCArXG4gICAgICAgICAgJy4gTWFrZSBzdXJlIHlvdSBzdWJzY3JpYmUgdG8gbGl2ZSBxdWVyeSBzZXJ2ZXIgYmVmb3JlIHVuc3Vic2NyaWJpbmcuJ1xuICAgICAgKTtcbiAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgJ0NhbiBub3QgZmluZCBzdWJzY3JpcHRpb24gd2l0aCBjbGllbnRJZCAnICtcbiAgICAgICAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCArXG4gICAgICAgICAgJyBzdWJzY3JpcHRpb25JZCAnICtcbiAgICAgICAgICByZXF1ZXN0SWRcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gUmVtb3ZlIHN1YnNjcmlwdGlvbiBmcm9tIGNsaWVudFxuICAgIGNsaWVudC5kZWxldGVTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgLy8gUmVtb3ZlIGNsaWVudCBmcm9tIHN1YnNjcmlwdGlvblxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbiA9IHN1YnNjcmlwdGlvbkluZm8uc3Vic2NyaXB0aW9uO1xuICAgIGNvbnN0IGNsYXNzTmFtZSA9IHN1YnNjcmlwdGlvbi5jbGFzc05hbWU7XG4gICAgc3Vic2NyaXB0aW9uLmRlbGV0ZUNsaWVudFN1YnNjcmlwdGlvbihwYXJzZVdlYnNvY2tldC5jbGllbnRJZCwgcmVxdWVzdElkKTtcbiAgICAvLyBJZiB0aGVyZSBpcyBubyBjbGllbnQgd2hpY2ggaXMgc3Vic2NyaWJpbmcgdGhpcyBzdWJzY3JpcHRpb24sIHJlbW92ZSBpdCBmcm9tIHN1YnNjcmlwdGlvbnNcbiAgICBjb25zdCBjbGFzc1N1YnNjcmlwdGlvbnMgPSB0aGlzLnN1YnNjcmlwdGlvbnMuZ2V0KGNsYXNzTmFtZSk7XG4gICAgaWYgKCFzdWJzY3JpcHRpb24uaGFzU3Vic2NyaWJpbmdDbGllbnQoKSkge1xuICAgICAgY2xhc3NTdWJzY3JpcHRpb25zLmRlbGV0ZShzdWJzY3JpcHRpb24uaGFzaCk7XG4gICAgfVxuICAgIC8vIElmIHRoZXJlIGlzIG5vIHN1YnNjcmlwdGlvbnMgdW5kZXIgdGhpcyBjbGFzcywgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMuc2l6ZSA9PT0gMCkge1xuICAgICAgdGhpcy5zdWJzY3JpcHRpb25zLmRlbGV0ZShjbGFzc05hbWUpO1xuICAgIH1cbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGV2ZW50OiAndW5zdWJzY3JpYmUnLFxuICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICB9KTtcblxuICAgIGlmICghbm90aWZ5Q2xpZW50KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY2xpZW50LnB1c2hVbnN1YnNjcmliZShyZXF1ZXN0LnJlcXVlc3RJZCk7XG5cbiAgICBsb2dnZXIudmVyYm9zZShcbiAgICAgIGBEZWxldGUgY2xpZW50OiAke3BhcnNlV2Vic29ja2V0LmNsaWVudElkfSB8IHN1YnNjcmlwdGlvbjogJHtcbiAgICAgICAgcmVxdWVzdC5yZXF1ZXN0SWRcbiAgICAgIH1gXG4gICAgKTtcbiAgfVxufVxuXG5leHBvcnQgeyBQYXJzZUxpdmVRdWVyeVNlcnZlciB9O1xuIl19