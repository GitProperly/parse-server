"use strict";

// An object that encapsulates everything we need to run a 'find'
// operation, encoded in the REST API format.
var SchemaController = require('./Controllers/SchemaController');

var Parse = require('parse/node').Parse;

const triggers = require('./triggers');

const {
  continueWhile
} = require('parse/lib/node/promiseUtils');

const AlwaysSelectedKeys = ['objectId', 'createdAt', 'updatedAt', 'ACL']; // restOptions can include:
//   skip
//   limit
//   order
//   count
//   include
//   keys
//   excludeKeys
//   redirectClassNameForKey
//   readPreference
//   includeReadPreference
//   subqueryReadPreference

function RestQuery(config, auth, className, restWhere = {}, restOptions = {}, clientSDK) {
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.restWhere = restWhere;
  this.restOptions = restOptions;
  this.clientSDK = clientSDK;
  this.response = null;
  this.findOptions = {};

  if (!this.auth.isMaster) {
    if (this.className == '_Session') {
      if (!this.auth.user) {
        throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
      }

      this.restWhere = {
        $and: [this.restWhere, {
          user: {
            __type: 'Pointer',
            className: '_User',
            objectId: this.auth.user.id
          }
        }]
      };
    }
  }

  this.doCount = false;
  this.includeAll = false; // The format for this.include is not the same as the format for the
  // include option - it's the paths we should include, in order,
  // stored as arrays, taking into account that we need to include foo
  // before including foo.bar. Also it should dedupe.
  // For example, passing an arg of include=foo.bar,foo.baz could lead to
  // this.include = [['foo'], ['foo', 'baz'], ['foo', 'bar']]

  this.include = []; // If we have keys, we probably want to force some includes (n-1 level)
  // See issue: https://github.com/parse-community/parse-server/issues/3185

  if (restOptions.hasOwnProperty('keys')) {
    const keysForInclude = restOptions.keys.split(',').filter(key => {
      // At least 2 components
      return key.split('.').length > 1;
    }).map(key => {
      // Slice the last component (a.b.c -> a.b)
      // Otherwise we'll include one level too much.
      return key.slice(0, key.lastIndexOf('.'));
    }).join(','); // Concat the possibly present include string with the one from the keys
    // Dedup / sorting is handle in 'include' case.

    if (keysForInclude.length > 0) {
      if (!restOptions.include || restOptions.include.length == 0) {
        restOptions.include = keysForInclude;
      } else {
        restOptions.include += ',' + keysForInclude;
      }
    }
  }

  for (var option in restOptions) {
    switch (option) {
      case 'keys':
        {
          const keys = restOptions.keys.split(',').concat(AlwaysSelectedKeys);
          this.keys = Array.from(new Set(keys));
          break;
        }

      case 'excludeKeys':
        {
          const exclude = restOptions.excludeKeys.split(',').filter(k => AlwaysSelectedKeys.indexOf(k) < 0);
          this.excludeKeys = Array.from(new Set(exclude));
          break;
        }

      case 'count':
        this.doCount = true;
        break;

      case 'includeAll':
        this.includeAll = true;
        break;

      case 'distinct':
      case 'pipeline':
      case 'skip':
      case 'limit':
      case 'readPreference':
        this.findOptions[option] = restOptions[option];
        break;

      case 'order':
        var fields = restOptions.order.split(',');
        this.findOptions.sort = fields.reduce((sortMap, field) => {
          field = field.trim();

          if (field === '$score') {
            sortMap.score = {
              $meta: 'textScore'
            };
          } else if (field[0] == '-') {
            sortMap[field.slice(1)] = -1;
          } else {
            sortMap[field] = 1;
          }

          return sortMap;
        }, {});
        break;

      case 'include':
        {
          const paths = restOptions.include.split(',');

          if (paths.includes('*')) {
            this.includeAll = true;
            break;
          } // Load the existing includes (from keys)


          const pathSet = paths.reduce((memo, path) => {
            // Split each paths on . (a.b.c -> [a,b,c])
            // reduce to create all paths
            // ([a,b,c] -> {a: true, 'a.b': true, 'a.b.c': true})
            return path.split('.').reduce((memo, path, index, parts) => {
              memo[parts.slice(0, index + 1).join('.')] = true;
              return memo;
            }, memo);
          }, {});
          this.include = Object.keys(pathSet).map(s => {
            return s.split('.');
          }).sort((a, b) => {
            return a.length - b.length; // Sort by number of components
          });
          break;
        }

      case 'redirectClassNameForKey':
        this.redirectKey = restOptions.redirectClassNameForKey;
        this.redirectClassName = null;
        break;

      case 'includeReadPreference':
      case 'subqueryReadPreference':
        break;

      default:
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad option: ' + option);
    }
  }
} // A convenient method to perform all the steps of processing a query
// in order.
// Returns a promise for the response - an object with optional keys
// 'results' and 'count'.
// TODO: consolidate the replaceX functions


RestQuery.prototype.execute = function (executeOptions) {
  return Promise.resolve().then(() => {
    return this.buildRestWhere();
  }).then(() => {
    return this.handleIncludeAll();
  }).then(() => {
    return this.handleExcludeKeys();
  }).then(() => {
    return this.runFind(executeOptions);
  }).then(() => {
    return this.runCount();
  }).then(() => {
    return this.handleInclude();
  }).then(() => {
    return this.runAfterFindTrigger();
  }).then(() => {
    return this.response;
  });
};

RestQuery.prototype.each = function (callback) {
  const {
    config,
    auth,
    className,
    restWhere,
    restOptions,
    clientSDK
  } = this; // if the limit is set, use it

  restOptions.limit = restOptions.limit || 100;
  restOptions.order = 'objectId';
  let finished = false;
  return continueWhile(() => {
    return !finished;
  }, async () => {
    const query = new RestQuery(config, auth, className, restWhere, restOptions, clientSDK);
    const {
      results
    } = await query.execute();
    results.forEach(callback);
    finished = results.length < restOptions.limit;

    if (!finished) {
      restWhere.objectId = Object.assign({}, restWhere.objectId, {
        $gt: results[results.length - 1].objectId
      });
    }
  });
};

RestQuery.prototype.buildRestWhere = function () {
  return Promise.resolve().then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.redirectClassNameForKey();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.replaceSelect();
  }).then(() => {
    return this.replaceDontSelect();
  }).then(() => {
    return this.replaceInQuery();
  }).then(() => {
    return this.replaceNotInQuery();
  }).then(() => {
    return this.replaceEquality();
  });
}; // Uses the Auth object to get the list of roles, adds the user id


RestQuery.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster) {
    return Promise.resolve();
  }

  this.findOptions.acl = ['*'];

  if (this.auth.user) {
    return this.auth.getUserRoles().then(roles => {
      this.findOptions.acl = this.findOptions.acl.concat(roles, [this.auth.user.id]);
      return;
    });
  } else {
    return Promise.resolve();
  }
}; // Changes the className if redirectClassNameForKey is set.
// Returns a promise.


RestQuery.prototype.redirectClassNameForKey = function () {
  if (!this.redirectKey) {
    return Promise.resolve();
  } // We need to change the class name based on the schema


  return this.config.database.redirectClassNameForKey(this.className, this.redirectKey).then(newClassName => {
    this.className = newClassName;
    this.redirectClassName = newClassName;
  });
}; // Validates this operation against the allowClientClassCreation config.


RestQuery.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className);
      }
    });
  } else {
    return Promise.resolve();
  }
};

function transformInQuery(inQueryObject, className, results) {
  var values = [];

  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }

  delete inQueryObject['$inQuery'];

  if (Array.isArray(inQueryObject['$in'])) {
    inQueryObject['$in'] = inQueryObject['$in'].concat(values);
  } else {
    inQueryObject['$in'] = values;
  }
} // Replaces a $inQuery clause by running the subquery, if there is an
// $inQuery clause.
// The $inQuery clause turns into an $in with values that are just
// pointers to the objects returned in the subquery.


RestQuery.prototype.replaceInQuery = function () {
  var inQueryObject = findObjectWithKey(this.restWhere, '$inQuery');

  if (!inQueryObject) {
    return;
  } // The inQuery value must have precisely two keys - where and className


  var inQueryValue = inQueryObject['$inQuery'];

  if (!inQueryValue.where || !inQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $inQuery');
  }

  const additionalOptions = {
    redirectClassNameForKey: inQueryValue.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, inQueryValue.className, inQueryValue.where, additionalOptions);
  return subquery.execute().then(response => {
    transformInQuery(inQueryObject, subquery.className, response.results); // Recurse to repeat

    return this.replaceInQuery();
  });
};

function transformNotInQuery(notInQueryObject, className, results) {
  var values = [];

  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }

  delete notInQueryObject['$notInQuery'];

  if (Array.isArray(notInQueryObject['$nin'])) {
    notInQueryObject['$nin'] = notInQueryObject['$nin'].concat(values);
  } else {
    notInQueryObject['$nin'] = values;
  }
} // Replaces a $notInQuery clause by running the subquery, if there is an
// $notInQuery clause.
// The $notInQuery clause turns into a $nin with values that are just
// pointers to the objects returned in the subquery.


RestQuery.prototype.replaceNotInQuery = function () {
  var notInQueryObject = findObjectWithKey(this.restWhere, '$notInQuery');

  if (!notInQueryObject) {
    return;
  } // The notInQuery value must have precisely two keys - where and className


  var notInQueryValue = notInQueryObject['$notInQuery'];

  if (!notInQueryValue.where || !notInQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $notInQuery');
  }

  const additionalOptions = {
    redirectClassNameForKey: notInQueryValue.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, notInQueryValue.className, notInQueryValue.where, additionalOptions);
  return subquery.execute().then(response => {
    transformNotInQuery(notInQueryObject, subquery.className, response.results); // Recurse to repeat

    return this.replaceNotInQuery();
  });
};

const transformSelect = (selectObject, key, objects) => {
  var values = [];

  for (var result of objects) {
    values.push(key.split('.').reduce((o, i) => o[i], result));
  }

  delete selectObject['$select'];

  if (Array.isArray(selectObject['$in'])) {
    selectObject['$in'] = selectObject['$in'].concat(values);
  } else {
    selectObject['$in'] = values;
  }
}; // Replaces a $select clause by running the subquery, if there is a
// $select clause.
// The $select clause turns into an $in with values selected out of
// the subquery.
// Returns a possible-promise.


RestQuery.prototype.replaceSelect = function () {
  var selectObject = findObjectWithKey(this.restWhere, '$select');

  if (!selectObject) {
    return;
  } // The select value must have precisely two keys - query and key


  var selectValue = selectObject['$select']; // iOS SDK don't send where if not set, let it pass

  if (!selectValue.query || !selectValue.key || typeof selectValue.query !== 'object' || !selectValue.query.className || Object.keys(selectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $select');
  }

  const additionalOptions = {
    redirectClassNameForKey: selectValue.query.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, selectValue.query.className, selectValue.query.where, additionalOptions);
  return subquery.execute().then(response => {
    transformSelect(selectObject, selectValue.key, response.results); // Keep replacing $select clauses

    return this.replaceSelect();
  });
};

const transformDontSelect = (dontSelectObject, key, objects) => {
  var values = [];

  for (var result of objects) {
    values.push(key.split('.').reduce((o, i) => o[i], result));
  }

  delete dontSelectObject['$dontSelect'];

  if (Array.isArray(dontSelectObject['$nin'])) {
    dontSelectObject['$nin'] = dontSelectObject['$nin'].concat(values);
  } else {
    dontSelectObject['$nin'] = values;
  }
}; // Replaces a $dontSelect clause by running the subquery, if there is a
// $dontSelect clause.
// The $dontSelect clause turns into an $nin with values selected out of
// the subquery.
// Returns a possible-promise.


RestQuery.prototype.replaceDontSelect = function () {
  var dontSelectObject = findObjectWithKey(this.restWhere, '$dontSelect');

  if (!dontSelectObject) {
    return;
  } // The dontSelect value must have precisely two keys - query and key


  var dontSelectValue = dontSelectObject['$dontSelect'];

  if (!dontSelectValue.query || !dontSelectValue.key || typeof dontSelectValue.query !== 'object' || !dontSelectValue.query.className || Object.keys(dontSelectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $dontSelect');
  }

  const additionalOptions = {
    redirectClassNameForKey: dontSelectValue.query.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, dontSelectValue.query.className, dontSelectValue.query.where, additionalOptions);
  return subquery.execute().then(response => {
    transformDontSelect(dontSelectObject, dontSelectValue.key, response.results); // Keep replacing $dontSelect clauses

    return this.replaceDontSelect();
  });
};

const cleanResultAuthData = function (result) {
  delete result.password;

  if (result.authData) {
    Object.keys(result.authData).forEach(provider => {
      if (result.authData[provider] === null) {
        delete result.authData[provider];
      }
    });

    if (Object.keys(result.authData).length == 0) {
      delete result.authData;
    }
  }
};

const replaceEqualityConstraint = constraint => {
  if (typeof constraint !== 'object') {
    return constraint;
  }

  const equalToObject = {};
  let hasDirectConstraint = false;
  let hasOperatorConstraint = false;

  for (const key in constraint) {
    if (key.indexOf('$') !== 0) {
      hasDirectConstraint = true;
      equalToObject[key] = constraint[key];
    } else {
      hasOperatorConstraint = true;
    }
  }

  if (hasDirectConstraint && hasOperatorConstraint) {
    constraint['$eq'] = equalToObject;
    Object.keys(equalToObject).forEach(key => {
      delete constraint[key];
    });
  }

  return constraint;
};

RestQuery.prototype.replaceEquality = function () {
  if (typeof this.restWhere !== 'object') {
    return;
  }

  for (const key in this.restWhere) {
    this.restWhere[key] = replaceEqualityConstraint(this.restWhere[key]);
  }
}; // Returns a promise for whether it was successful.
// Populates this.response with an object that only has 'results'.


RestQuery.prototype.runFind = function (options = {}) {
  if (this.findOptions.limit === 0) {
    this.response = {
      results: []
    };
    return Promise.resolve();
  }

  const findOptions = Object.assign({}, this.findOptions);

  if (this.keys) {
    findOptions.keys = this.keys.map(key => {
      return key.split('.')[0];
    });
  }

  if (options.op) {
    findOptions.op = options.op;
  }

  return this.config.database.find(this.className, this.restWhere, findOptions, this.auth).then(results => {
    if (this.className === '_User') {
      for (var result of results) {
        cleanResultAuthData(result);
      }
    }

    (this.config.queryMiddleware || []).forEach(ware => results = ware(this.className, results, this.auth));
    this.config.filesController.expandFilesInObject(this.config, results);

    if (this.redirectClassName) {
      for (var r of results) {
        r.className = this.redirectClassName;
      }
    }

    this.response = {
      results: results
    };
  });
}; // Returns a promise for whether it was successful.
// Populates this.response.count with the count


RestQuery.prototype.runCount = function () {
  if (!this.doCount) {
    return;
  }

  this.findOptions.count = true;
  delete this.findOptions.skip;
  delete this.findOptions.limit;
  return this.config.database.find(this.className, this.restWhere, this.findOptions).then(c => {
    this.response.count = c;
  });
}; // Augments this.response with all pointers on an object


RestQuery.prototype.handleIncludeAll = function () {
  if (!this.includeAll) {
    return;
  }

  return this.config.database.loadSchema().then(schemaController => schemaController.getOneSchema(this.className)).then(schema => {
    const includeFields = [];
    const keyFields = [];

    for (const field in schema.fields) {
      if (schema.fields[field].type && schema.fields[field].type === 'Pointer') {
        includeFields.push([field]);
        keyFields.push(field);
      }
    } // Add fields to include, keys, remove dups


    this.include = [...new Set([...this.include, ...includeFields])]; // if this.keys not set, then all keys are already included

    if (this.keys) {
      this.keys = [...new Set([...this.keys, ...keyFields])];
    }
  });
}; // Updates property `this.keys` to contain all keys but the ones unselected.


RestQuery.prototype.handleExcludeKeys = function () {
  if (!this.excludeKeys) {
    return;
  }

  if (this.keys) {
    this.keys = this.keys.filter(k => !this.excludeKeys.includes(k));
    return;
  }

  return this.config.database.loadSchema().then(schemaController => schemaController.getOneSchema(this.className)).then(schema => {
    const fields = Object.keys(schema.fields);
    this.keys = fields.filter(k => !this.excludeKeys.includes(k));
  });
}; // Augments this.response with data at the paths provided in this.include.


RestQuery.prototype.handleInclude = function () {
  if (this.include.length == 0) {
    return;
  }

  var pathResponse = includePath(this.config, this.auth, this.response, this.include[0], this.restOptions);

  if (pathResponse.then) {
    return pathResponse.then(newResponse => {
      this.response = newResponse;
      this.include = this.include.slice(1);
      return this.handleInclude();
    });
  } else if (this.include.length > 0) {
    this.include = this.include.slice(1);
    return this.handleInclude();
  }

  return pathResponse;
}; //Returns a promise of a processed set of results


RestQuery.prototype.runAfterFindTrigger = function () {
  if (!this.response) {
    return;
  } // Avoid doing any setup for triggers if there is no 'afterFind' trigger for this class.


  const hasAfterFindHook = triggers.triggerExists(this.className, triggers.Types.afterFind, this.config.applicationId);

  if (!hasAfterFindHook) {
    return Promise.resolve();
  } // Skip Aggregate and Distinct Queries


  if (this.findOptions.pipeline || this.findOptions.distinct) {
    return Promise.resolve();
  } // Run afterFind trigger and set the new results


  return triggers.maybeRunAfterFindTrigger(triggers.Types.afterFind, this.auth, this.className, this.response.results, this.config).then(results => {
    // Ensure we properly set the className back
    if (this.redirectClassName) {
      this.response.results = results.map(object => {
        if (object instanceof Parse.Object) {
          object = object.toJSON();
        }

        object.className = this.redirectClassName;
        return object;
      });
    } else {
      this.response.results = results;
    }
  });
}; // Adds included values to the response.
// Path is a list of field names.
// Returns a promise for an augmented response.


function includePath(config, auth, response, path, restOptions = {}) {
  var pointers = findPointers(response.results, path);

  if (pointers.length == 0) {
    return response;
  }

  const pointersHash = {};

  for (var pointer of pointers) {
    if (!pointer) {
      continue;
    }

    const className = pointer.className; // only include the good pointers

    if (className) {
      pointersHash[className] = pointersHash[className] || new Set();
      pointersHash[className].add(pointer.objectId);
    }
  }

  const includeRestOptions = {};

  if (restOptions.keys) {
    const keys = new Set(restOptions.keys.split(','));
    const keySet = Array.from(keys).reduce((set, key) => {
      const keyPath = key.split('.');
      let i = 0;

      for (i; i < path.length; i++) {
        if (path[i] != keyPath[i]) {
          return set;
        }
      }

      if (i < keyPath.length) {
        set.add(keyPath[i]);
      }

      return set;
    }, new Set());

    if (keySet.size > 0) {
      includeRestOptions.keys = Array.from(keySet).join(',');
    }
  }

  if (restOptions.includeReadPreference) {
    includeRestOptions.readPreference = restOptions.includeReadPreference;
    includeRestOptions.includeReadPreference = restOptions.includeReadPreference;
  } else if (restOptions.readPreference) {
    includeRestOptions.readPreference = restOptions.readPreference;
  }

  const queryPromises = Object.keys(pointersHash).map(className => {
    const objectIds = Array.from(pointersHash[className]);
    let where;

    if (objectIds.length === 1) {
      where = {
        objectId: objectIds[0]
      };
    } else {
      where = {
        objectId: {
          $in: objectIds
        }
      };
    }

    var query = new RestQuery(config, auth, className, where, includeRestOptions);
    return query.execute({
      op: 'get'
    }).then(results => {
      results.className = className;
      return Promise.resolve(results);
    });
  }); // Get the objects for all these object ids

  return Promise.all(queryPromises).then(responses => {
    var replace = responses.reduce((replace, includeResponse) => {
      for (var obj of includeResponse.results) {
        obj.__type = 'Object';
        obj.className = includeResponse.className;

        if (obj.className == '_User' && !auth.isMaster) {
          delete obj.sessionToken;
          delete obj.authData;
        }

        replace[obj.objectId] = obj;
      }

      return replace;
    }, {});
    var resp = {
      results: replacePointers(response.results, path, replace)
    };

    if (response.count) {
      resp.count = response.count;
    }

    return resp;
  });
} // Object may be a list of REST-format object to find pointers in, or
// it may be a single object.
// If the path yields things that aren't pointers, this throws an error.
// Path is a list of fields to search into.
// Returns a list of pointers in REST format.


function findPointers(object, path) {
  if (object instanceof Array) {
    var answer = [];

    for (var x of object) {
      answer = answer.concat(findPointers(x, path));
    }

    return answer;
  }

  if (typeof object !== 'object' || !object) {
    return [];
  }

  if (path.length == 0) {
    if (object === null || object.__type == 'Pointer') {
      return [object];
    }

    return [];
  }

  var subobject = object[path[0]];

  if (!subobject) {
    return [];
  }

  return findPointers(subobject, path.slice(1));
} // Object may be a list of REST-format objects to replace pointers
// in, or it may be a single object.
// Path is a list of fields to search into.
// replace is a map from object id -> object.
// Returns something analogous to object, but with the appropriate
// pointers inflated.


function replacePointers(object, path, replace) {
  if (object instanceof Array) {
    return object.map(obj => replacePointers(obj, path, replace)).filter(obj => typeof obj !== 'undefined');
  }

  if (typeof object !== 'object' || !object) {
    return object;
  }

  if (path.length === 0) {
    if (object && object.__type === 'Pointer') {
      return replace[object.objectId];
    }

    return object;
  }

  var subobject = object[path[0]];

  if (!subobject) {
    return object;
  }

  var newsub = replacePointers(subobject, path.slice(1), replace);
  var answer = {};

  for (var key in object) {
    if (key == path[0]) {
      answer[key] = newsub;
    } else {
      answer[key] = object[key];
    }
  }

  return answer;
} // Finds a subobject that has the given key, if there is one.
// Returns undefined otherwise.


function findObjectWithKey(root, key) {
  if (typeof root !== 'object') {
    return;
  }

  if (root instanceof Array) {
    for (var item of root) {
      const answer = findObjectWithKey(item, key);

      if (answer) {
        return answer;
      }
    }
  }

  if (root && root[key]) {
    return root;
  }

  for (var subkey in root) {
    const answer = findObjectWithKey(root[subkey], key);

    if (answer) {
      return answer;
    }
  }
}

module.exports = RestQuery;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0UXVlcnkuanMiXSwibmFtZXMiOlsiU2NoZW1hQ29udHJvbGxlciIsInJlcXVpcmUiLCJQYXJzZSIsInRyaWdnZXJzIiwiY29udGludWVXaGlsZSIsIkFsd2F5c1NlbGVjdGVkS2V5cyIsIlJlc3RRdWVyeSIsImNvbmZpZyIsImF1dGgiLCJjbGFzc05hbWUiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsImNsaWVudFNESyIsInJlc3BvbnNlIiwiZmluZE9wdGlvbnMiLCJpc01hc3RlciIsInVzZXIiLCJFcnJvciIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsIiRhbmQiLCJfX3R5cGUiLCJvYmplY3RJZCIsImlkIiwiZG9Db3VudCIsImluY2x1ZGVBbGwiLCJpbmNsdWRlIiwiaGFzT3duUHJvcGVydHkiLCJrZXlzRm9ySW5jbHVkZSIsImtleXMiLCJzcGxpdCIsImZpbHRlciIsImtleSIsImxlbmd0aCIsIm1hcCIsInNsaWNlIiwibGFzdEluZGV4T2YiLCJqb2luIiwib3B0aW9uIiwiY29uY2F0IiwiQXJyYXkiLCJmcm9tIiwiU2V0IiwiZXhjbHVkZSIsImV4Y2x1ZGVLZXlzIiwiayIsImluZGV4T2YiLCJmaWVsZHMiLCJvcmRlciIsInNvcnQiLCJyZWR1Y2UiLCJzb3J0TWFwIiwiZmllbGQiLCJ0cmltIiwic2NvcmUiLCIkbWV0YSIsInBhdGhzIiwiaW5jbHVkZXMiLCJwYXRoU2V0IiwibWVtbyIsInBhdGgiLCJpbmRleCIsInBhcnRzIiwiT2JqZWN0IiwicyIsImEiLCJiIiwicmVkaXJlY3RLZXkiLCJyZWRpcmVjdENsYXNzTmFtZUZvcktleSIsInJlZGlyZWN0Q2xhc3NOYW1lIiwiSU5WQUxJRF9KU09OIiwicHJvdG90eXBlIiwiZXhlY3V0ZSIsImV4ZWN1dGVPcHRpb25zIiwiUHJvbWlzZSIsInJlc29sdmUiLCJ0aGVuIiwiYnVpbGRSZXN0V2hlcmUiLCJoYW5kbGVJbmNsdWRlQWxsIiwiaGFuZGxlRXhjbHVkZUtleXMiLCJydW5GaW5kIiwicnVuQ291bnQiLCJoYW5kbGVJbmNsdWRlIiwicnVuQWZ0ZXJGaW5kVHJpZ2dlciIsImVhY2giLCJjYWxsYmFjayIsImxpbWl0IiwiZmluaXNoZWQiLCJxdWVyeSIsInJlc3VsdHMiLCJmb3JFYWNoIiwiYXNzaWduIiwiJGd0IiwiZ2V0VXNlckFuZFJvbGVBQ0wiLCJ2YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24iLCJyZXBsYWNlU2VsZWN0IiwicmVwbGFjZURvbnRTZWxlY3QiLCJyZXBsYWNlSW5RdWVyeSIsInJlcGxhY2VOb3RJblF1ZXJ5IiwicmVwbGFjZUVxdWFsaXR5IiwiYWNsIiwiZ2V0VXNlclJvbGVzIiwicm9sZXMiLCJkYXRhYmFzZSIsIm5ld0NsYXNzTmFtZSIsImFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiIsInN5c3RlbUNsYXNzZXMiLCJsb2FkU2NoZW1hIiwic2NoZW1hQ29udHJvbGxlciIsImhhc0NsYXNzIiwiT1BFUkFUSU9OX0ZPUkJJRERFTiIsInRyYW5zZm9ybUluUXVlcnkiLCJpblF1ZXJ5T2JqZWN0IiwidmFsdWVzIiwicmVzdWx0IiwicHVzaCIsImlzQXJyYXkiLCJmaW5kT2JqZWN0V2l0aEtleSIsImluUXVlcnlWYWx1ZSIsIndoZXJlIiwiSU5WQUxJRF9RVUVSWSIsImFkZGl0aW9uYWxPcHRpb25zIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsInJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnkiLCJ0cmFuc2Zvcm1Ob3RJblF1ZXJ5Iiwibm90SW5RdWVyeU9iamVjdCIsIm5vdEluUXVlcnlWYWx1ZSIsInRyYW5zZm9ybVNlbGVjdCIsInNlbGVjdE9iamVjdCIsIm9iamVjdHMiLCJvIiwiaSIsInNlbGVjdFZhbHVlIiwidHJhbnNmb3JtRG9udFNlbGVjdCIsImRvbnRTZWxlY3RPYmplY3QiLCJkb250U2VsZWN0VmFsdWUiLCJjbGVhblJlc3VsdEF1dGhEYXRhIiwicGFzc3dvcmQiLCJhdXRoRGF0YSIsInByb3ZpZGVyIiwicmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCIsImNvbnN0cmFpbnQiLCJlcXVhbFRvT2JqZWN0IiwiaGFzRGlyZWN0Q29uc3RyYWludCIsImhhc09wZXJhdG9yQ29uc3RyYWludCIsIm9wdGlvbnMiLCJvcCIsImZpbmQiLCJxdWVyeU1pZGRsZXdhcmUiLCJ3YXJlIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsInIiLCJjb3VudCIsInNraXAiLCJjIiwiZ2V0T25lU2NoZW1hIiwic2NoZW1hIiwiaW5jbHVkZUZpZWxkcyIsImtleUZpZWxkcyIsInR5cGUiLCJwYXRoUmVzcG9uc2UiLCJpbmNsdWRlUGF0aCIsIm5ld1Jlc3BvbnNlIiwiaGFzQWZ0ZXJGaW5kSG9vayIsInRyaWdnZXJFeGlzdHMiLCJUeXBlcyIsImFmdGVyRmluZCIsImFwcGxpY2F0aW9uSWQiLCJwaXBlbGluZSIsImRpc3RpbmN0IiwibWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyIiwib2JqZWN0IiwidG9KU09OIiwicG9pbnRlcnMiLCJmaW5kUG9pbnRlcnMiLCJwb2ludGVyc0hhc2giLCJwb2ludGVyIiwiYWRkIiwiaW5jbHVkZVJlc3RPcHRpb25zIiwia2V5U2V0Iiwic2V0Iiwia2V5UGF0aCIsInNpemUiLCJpbmNsdWRlUmVhZFByZWZlcmVuY2UiLCJxdWVyeVByb21pc2VzIiwib2JqZWN0SWRzIiwiJGluIiwiYWxsIiwicmVzcG9uc2VzIiwicmVwbGFjZSIsImluY2x1ZGVSZXNwb25zZSIsIm9iaiIsInNlc3Npb25Ub2tlbiIsInJlc3AiLCJyZXBsYWNlUG9pbnRlcnMiLCJhbnN3ZXIiLCJ4Iiwic3Vib2JqZWN0IiwibmV3c3ViIiwicm9vdCIsIml0ZW0iLCJzdWJrZXkiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBO0FBQ0E7QUFFQSxJQUFJQSxnQkFBZ0IsR0FBR0MsT0FBTyxDQUFDLGdDQUFELENBQTlCOztBQUNBLElBQUlDLEtBQUssR0FBR0QsT0FBTyxDQUFDLFlBQUQsQ0FBUCxDQUFzQkMsS0FBbEM7O0FBQ0Es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QUQsQ0FBZixFQUFvQjtBQUNsQnlJLE1BQUFBLE1BQU0sQ0FBQ3JLLEdBQUQsQ0FBTixHQUFjd0ssTUFBZDtBQUNELEtBRkQsTUFFTztBQUNMSCxNQUFBQSxNQUFNLENBQUNySyxHQUFELENBQU4sR0FBYzZJLE1BQU0sQ0FBQzdJLEdBQUQsQ0FBcEI7QUFDRDtBQUNGOztBQUNELFNBQU9xSyxNQUFQO0FBQ0QsQyxDQUVEO0FBQ0E7OztBQUNBLFNBQVNoRixpQkFBVCxDQUEyQm9GLElBQTNCLEVBQWlDekssR0FBakMsRUFBc0M7QUFDcEMsTUFBSSxPQUFPeUssSUFBUCxLQUFnQixRQUFwQixFQUE4QjtBQUM1QjtBQUNEOztBQUNELE1BQUlBLElBQUksWUFBWWpLLEtBQXBCLEVBQTJCO0FBQ3pCLFNBQUssSUFBSWtLLElBQVQsSUFBaUJELElBQWpCLEVBQXVCO0FBQ3JCLFlBQU1KLE1BQU0sR0FBR2hGLGlCQUFpQixDQUFDcUYsSUFBRCxFQUFPMUssR0FBUCxDQUFoQzs7QUFDQSxVQUFJcUssTUFBSixFQUFZO0FBQ1YsZUFBT0EsTUFBUDtBQUNEO0FBQ0Y7QUFDRjs7QUFDRCxNQUFJSSxJQUFJLElBQUlBLElBQUksQ0FBQ3pLLEdBQUQsQ0FBaEIsRUFBdUI7QUFDckIsV0FBT3lLLElBQVA7QUFDRDs7QUFDRCxPQUFLLElBQUlFLE1BQVQsSUFBbUJGLElBQW5CLEVBQXlCO0FBQ3ZCLFVBQU1KLE1BQU0sR0FBR2hGLGlCQUFpQixDQUFDb0YsSUFBSSxDQUFDRSxNQUFELENBQUwsRUFBZTNLLEdBQWYsQ0FBaEM7O0FBQ0EsUUFBSXFLLE1BQUosRUFBWTtBQUNWLGFBQU9BLE1BQVA7QUFDRDtBQUNGO0FBQ0Y7O0FBRURPLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnRNLFNBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQW4gb2JqZWN0IHRoYXQgZW5jYXBzdWxhdGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCB0byBydW4gYSAnZmluZCdcbi8vIG9wZXJhdGlvbiwgZW5jb2RlZCBpbiB0aGUgUkVTVCBBUEkgZm9ybWF0LlxuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpLlBhcnNlO1xuY29uc3QgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG5jb25zdCB7IGNvbnRpbnVlV2hpbGUgfSA9IHJlcXVpcmUoJ3BhcnNlL2xpYi9ub2RlL3Byb21pc2VVdGlscycpO1xuY29uc3QgQWx3YXlzU2VsZWN0ZWRLZXlzID0gWydvYmplY3RJZCcsICdjcmVhdGVkQXQnLCAndXBkYXRlZEF0JywgJ0FDTCddO1xuLy8gcmVzdE9wdGlvbnMgY2FuIGluY2x1ZGU6XG4vLyAgIHNraXBcbi8vICAgbGltaXRcbi8vICAgb3JkZXJcbi8vICAgY291bnRcbi8vICAgaW5jbHVkZVxuLy8gICBrZXlzXG4vLyAgIGV4Y2x1ZGVLZXlzXG4vLyAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5XG4vLyAgIHJlYWRQcmVmZXJlbmNlXG4vLyAgIGluY2x1ZGVSZWFkUHJlZmVyZW5jZVxuLy8gICBzdWJxdWVyeVJlYWRQcmVmZXJlbmNlXG5mdW5jdGlvbiBSZXN0UXVlcnkoXG4gIGNvbmZpZyxcbiAgYXV0aCxcbiAgY2xhc3NOYW1lLFxuICByZXN0V2hlcmUgPSB7fSxcbiAgcmVzdE9wdGlvbnMgPSB7fSxcbiAgY2xpZW50U0RLXG4pIHtcbiAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gIHRoaXMuYXV0aCA9IGF1dGg7XG4gIHRoaXMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB0aGlzLnJlc3RXaGVyZSA9IHJlc3RXaGVyZTtcbiAgdGhpcy5yZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zO1xuICB0aGlzLmNsaWVudFNESyA9IGNsaWVudFNESztcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG4gIHRoaXMuZmluZE9wdGlvbnMgPSB7fTtcblxuICBpZiAoIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PSAnX1Nlc3Npb24nKSB7XG4gICAgICBpZiAoIXRoaXMuYXV0aC51c2VyKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sXG4gICAgICAgICAgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHRoaXMucmVzdFdoZXJlID0ge1xuICAgICAgICAkYW5kOiBbXG4gICAgICAgICAgdGhpcy5yZXN0V2hlcmUsXG4gICAgICAgICAge1xuICAgICAgICAgICAgdXNlcjoge1xuICAgICAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgICAgICBvYmplY3RJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHRoaXMuZG9Db3VudCA9IGZhbHNlO1xuICB0aGlzLmluY2x1ZGVBbGwgPSBmYWxzZTtcblxuICAvLyBUaGUgZm9ybWF0IGZvciB0aGlzLmluY2x1ZGUgaXMgbm90IHRoZSBzYW1lIGFzIHRoZSBmb3JtYXQgZm9yIHRoZVxuICAvLyBpbmNsdWRlIG9wdGlvbiAtIGl0J3MgdGhlIHBhdGhzIHdlIHNob3VsZCBpbmNsdWRlLCBpbiBvcmRlcixcbiAgLy8gc3RvcmVkIGFzIGFycmF5cywgdGFraW5nIGludG8gYWNjb3VudCB0aGF0IHdlIG5lZWQgdG8gaW5jbHVkZSBmb29cbiAgLy8gYmVmb3JlIGluY2x1ZGluZyBmb28uYmFyLiBBbHNvIGl0IHNob3VsZCBkZWR1cGUuXG4gIC8vIEZvciBleGFtcGxlLCBwYXNzaW5nIGFuIGFyZyBvZiBpbmNsdWRlPWZvby5iYXIsZm9vLmJheiBjb3VsZCBsZWFkIHRvXG4gIC8vIHRoaXMuaW5jbHVkZSA9IFtbJ2ZvbyddLCBbJ2ZvbycsICdiYXonXSwgWydmb28nLCAnYmFyJ11dXG4gIHRoaXMuaW5jbHVkZSA9IFtdO1xuXG4gIC8vIElmIHdlIGhhdmUga2V5cywgd2UgcHJvYmFibHkgd2FudCB0byBmb3JjZSBzb21lIGluY2x1ZGVzIChuLTEgbGV2ZWwpXG4gIC8vIFNlZSBpc3N1ZTogaHR0cHM6Ly9naXRodWIuY29tL3BhcnNlLWNvbW11bml0eS9wYXJzZS1zZXJ2ZXIvaXNzdWVzLzMxODVcbiAgaWYgKHJlc3RPcHRpb25zLmhhc093blByb3BlcnR5KCdrZXlzJykpIHtcbiAgICBjb25zdCBrZXlzRm9ySW5jbHVkZSA9IHJlc3RPcHRpb25zLmtleXNcbiAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAuZmlsdGVyKGtleSA9PiB7XG4gICAgICAgIC8vIEF0IGxlYXN0IDIgY29tcG9uZW50c1xuICAgICAgICByZXR1cm4ga2V5LnNwbGl0KCcuJykubGVuZ3RoID4gMTtcbiAgICAgIH0pXG4gICAgICAubWFwKGtleSA9PiB7XG4gICAgICAgIC8vIFNsaWNlIHRoZSBsYXN0IGNvbXBvbmVudCAoYS5iLmMgLT4gYS5iKVxuICAgICAgICAvLyBPdGhlcndpc2Ugd2UnbGwgaW5jbHVkZSBvbmUgbGV2ZWwgdG9vIG11Y2guXG4gICAgICAgIHJldHVybiBrZXkuc2xpY2UoMCwga2V5Lmxhc3RJbmRleE9mKCcuJykpO1xuICAgICAgfSlcbiAgICAgIC5qb2luKCcsJyk7XG5cbiAgICAvLyBDb25jYXQgdGhlIHBvc3NpYmx5IHByZXNlbnQgaW5jbHVkZSBzdHJpbmcgd2l0aCB0aGUgb25lIGZyb20gdGhlIGtleXNcbiAgICAvLyBEZWR1cCAvIHNvcnRpbmcgaXMgaGFuZGxlIGluICdpbmNsdWRlJyBjYXNlLlxuICAgIGlmIChrZXlzRm9ySW5jbHVkZS5sZW5ndGggPiAwKSB7XG4gICAgICBpZiAoIXJlc3RPcHRpb25zLmluY2x1ZGUgfHwgcmVzdE9wdGlvbnMuaW5jbHVkZS5sZW5ndGggPT0gMCkge1xuICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlID0ga2V5c0ZvckluY2x1ZGU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlICs9ICcsJyArIGtleXNGb3JJbmNsdWRlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZvciAodmFyIG9wdGlvbiBpbiByZXN0T3B0aW9ucykge1xuICAgIHN3aXRjaCAob3B0aW9uKSB7XG4gICAgICBjYXNlICdrZXlzJzoge1xuICAgICAgICBjb25zdCBrZXlzID0gcmVzdE9wdGlvbnMua2V5cy5zcGxpdCgnLCcpLmNvbmNhdChBbHdheXNTZWxlY3RlZEtleXMpO1xuICAgICAgICB0aGlzLmtleXMgPSBBcnJheS5mcm9tKG5ldyBTZXQoa2V5cykpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJ2V4Y2x1ZGVLZXlzJzoge1xuICAgICAgICBjb25zdCBleGNsdWRlID0gcmVzdE9wdGlvbnMuZXhjbHVkZUtleXNcbiAgICAgICAgICAuc3BsaXQoJywnKVxuICAgICAgICAgIC5maWx0ZXIoayA9PiBBbHdheXNTZWxlY3RlZEtleXMuaW5kZXhPZihrKSA8IDApO1xuICAgICAgICB0aGlzLmV4Y2x1ZGVLZXlzID0gQXJyYXkuZnJvbShuZXcgU2V0KGV4Y2x1ZGUpKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdjb3VudCc6XG4gICAgICAgIHRoaXMuZG9Db3VudCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZUFsbCc6XG4gICAgICAgIHRoaXMuaW5jbHVkZUFsbCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnZGlzdGluY3QnOlxuICAgICAgY2FzZSAncGlwZWxpbmUnOlxuICAgICAgY2FzZSAnc2tpcCc6XG4gICAgICBjYXNlICdsaW1pdCc6XG4gICAgICBjYXNlICdyZWFkUHJlZmVyZW5jZSc6XG4gICAgICAgIHRoaXMuZmluZE9wdGlvbnNbb3B0aW9uXSA9IHJlc3RPcHRpb25zW29wdGlvbl07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnb3JkZXInOlxuICAgICAgICB2YXIgZmllbGRzID0gcmVzdE9wdGlvbnMub3JkZXIuc3BsaXQoJywnKTtcbiAgICAgICAgdGhpcy5maW5kT3B0aW9ucy5zb3J0ID0gZmllbGRzLnJlZHVjZSgoc29ydE1hcCwgZmllbGQpID0+IHtcbiAgICAgICAgICBmaWVsZCA9IGZpZWxkLnRyaW0oKTtcbiAgICAgICAgICBpZiAoZmllbGQgPT09ICckc2NvcmUnKSB7XG4gICAgICAgICAgICBzb3J0TWFwLnNjb3JlID0geyAkbWV0YTogJ3RleHRTY29yZScgfTtcbiAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkWzBdID09ICctJykge1xuICAgICAgICAgICAgc29ydE1hcFtmaWVsZC5zbGljZSgxKV0gPSAtMTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc29ydE1hcFtmaWVsZF0gPSAxO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gc29ydE1hcDtcbiAgICAgICAgfSwge30pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2luY2x1ZGUnOiB7XG4gICAgICAgIGNvbnN0IHBhdGhzID0gcmVzdE9wdGlvbnMuaW5jbHVkZS5zcGxpdCgnLCcpO1xuICAgICAgICBpZiAocGF0aHMuaW5jbHVkZXMoJyonKSkge1xuICAgICAgICAgIHRoaXMuaW5jbHVkZUFsbCA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgLy8gTG9hZCB0aGUgZXhpc3RpbmcgaW5jbHVkZXMgKGZyb20ga2V5cylcbiAgICAgICAgY29uc3QgcGF0aFNldCA9IHBhdGhzLnJlZHVjZSgobWVtbywgcGF0aCkgPT4ge1xuICAgICAgICAgIC8vIFNwbGl0IGVhY2ggcGF0aHMgb24gLiAoYS5iLmMgLT4gW2EsYixjXSlcbiAgICAgICAgICAvLyByZWR1Y2UgdG8gY3JlYXRlIGFsbCBwYXRoc1xuICAgICAgICAgIC8vIChbYSxiLGNdIC0+IHthOiB0cnVlLCAnYS5iJzogdHJ1ZSwgJ2EuYi5jJzogdHJ1ZX0pXG4gICAgICAgICAgcmV0dXJuIHBhdGguc3BsaXQoJy4nKS5yZWR1Y2UoKG1lbW8sIHBhdGgsIGluZGV4LCBwYXJ0cykgPT4ge1xuICAgICAgICAgICAgbWVtb1twYXJ0cy5zbGljZSgwLCBpbmRleCArIDEpLmpvaW4oJy4nKV0gPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICAgICAgfSwgbWVtbyk7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICB0aGlzLmluY2x1ZGUgPSBPYmplY3Qua2V5cyhwYXRoU2V0KVxuICAgICAgICAgIC5tYXAocyA9PiB7XG4gICAgICAgICAgICByZXR1cm4gcy5zcGxpdCgnLicpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBhLmxlbmd0aCAtIGIubGVuZ3RoOyAvLyBTb3J0IGJ5IG51bWJlciBvZiBjb21wb25lbnRzXG4gICAgICAgICAgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSAncmVkaXJlY3RDbGFzc05hbWVGb3JLZXknOlxuICAgICAgICB0aGlzLnJlZGlyZWN0S2V5ID0gcmVzdE9wdGlvbnMucmVkaXJlY3RDbGFzc05hbWVGb3JLZXk7XG4gICAgICAgIHRoaXMucmVkaXJlY3RDbGFzc05hbWUgPSBudWxsO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2luY2x1ZGVSZWFkUHJlZmVyZW5jZSc6XG4gICAgICBjYXNlICdzdWJxdWVyeVJlYWRQcmVmZXJlbmNlJzpcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICdiYWQgb3B0aW9uOiAnICsgb3B0aW9uXG4gICAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbi8vIEEgY29udmVuaWVudCBtZXRob2QgdG8gcGVyZm9ybSBhbGwgdGhlIHN0ZXBzIG9mIHByb2Nlc3NpbmcgYSBxdWVyeVxuLy8gaW4gb3JkZXIuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgdGhlIHJlc3BvbnNlIC0gYW4gb2JqZWN0IHdpdGggb3B0aW9uYWwga2V5c1xuLy8gJ3Jlc3VsdHMnIGFuZCAnY291bnQnLlxuLy8gVE9ETzogY29uc29saWRhdGUgdGhlIHJlcGxhY2VYIGZ1bmN0aW9uc1xuUmVzdFF1ZXJ5LnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24oZXhlY3V0ZU9wdGlvbnMpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuYnVpbGRSZXN0V2hlcmUoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGVBbGwoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUV4Y2x1ZGVLZXlzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5GaW5kKGV4ZWN1dGVPcHRpb25zKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkNvdW50KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVJbmNsdWRlKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5BZnRlckZpbmRUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXNwb25zZTtcbiAgICB9KTtcbn07XG5cblJlc3RRdWVyeS5wcm90b3R5cGUuZWFjaCA9IGZ1bmN0aW9uKGNhbGxiYWNrKSB7XG4gIGNvbnN0IHsgY29uZmlnLCBhdXRoLCBjbGFzc05hbWUsIHJlc3RXaGVyZSwgcmVzdE9wdGlvbnMsIGNsaWVudFNESyB9ID0gdGhpcztcbiAgLy8gaWYgdGhlIGxpbWl0IGlzIHNldCwgdXNlIGl0XG4gIHJlc3RPcHRpb25zLmxpbWl0ID0gcmVzdE9wdGlvbnMubGltaXQgfHwgMTAwO1xuICByZXN0T3B0aW9ucy5vcmRlciA9ICdvYmplY3RJZCc7XG4gIGxldCBmaW5pc2hlZCA9IGZhbHNlO1xuXG4gIHJldHVybiBjb250aW51ZVdoaWxlKFxuICAgICgpID0+IHtcbiAgICAgIHJldHVybiAhZmluaXNoZWQ7XG4gICAgfSxcbiAgICBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IG5ldyBSZXN0UXVlcnkoXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICByZXN0V2hlcmUsXG4gICAgICAgIHJlc3RPcHRpb25zLFxuICAgICAgICBjbGllbnRTREtcbiAgICAgICk7XG4gICAgICBjb25zdCB7IHJlc3VsdHMgfSA9IGF3YWl0IHF1ZXJ5LmV4ZWN1dGUoKTtcbiAgICAgIHJlc3VsdHMuZm9yRWFjaChjYWxsYmFjayk7XG4gICAgICBmaW5pc2hlZCA9IHJlc3VsdHMubGVuZ3RoIDwgcmVzdE9wdGlvbnMubGltaXQ7XG4gICAgICBpZiAoIWZpbmlzaGVkKSB7XG4gICAgICAgIHJlc3RXaGVyZS5vYmplY3RJZCA9IE9iamVjdC5hc3NpZ24oe30sIHJlc3RXaGVyZS5vYmplY3RJZCwge1xuICAgICAgICAgICRndDogcmVzdWx0c1tyZXN1bHRzLmxlbmd0aCAtIDFdLm9iamVjdElkLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICk7XG59O1xuXG5SZXN0UXVlcnkucHJvdG90eXBlLmJ1aWxkUmVzdFdoZXJlID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmdldFVzZXJBbmRSb2xlQUNMKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZWRpcmVjdENsYXNzTmFtZUZvcktleSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXBsYWNlU2VsZWN0KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXBsYWNlRG9udFNlbGVjdCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVwbGFjZUluUXVlcnkoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlcGxhY2VOb3RJblF1ZXJ5KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXBsYWNlRXF1YWxpdHkoKTtcbiAgICB9KTtcbn07XG5cbi8vIFVzZXMgdGhlIEF1dGggb2JqZWN0IHRvIGdldCB0aGUgbGlzdCBvZiByb2xlcywgYWRkcyB0aGUgdXNlciBpZFxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5nZXRVc2VyQW5kUm9sZUFDTCA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgdGhpcy5maW5kT3B0aW9ucy5hY2wgPSBbJyonXTtcblxuICBpZiAodGhpcy5hdXRoLnVzZXIpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLmdldFVzZXJSb2xlcygpLnRoZW4ocm9sZXMgPT4ge1xuICAgICAgdGhpcy5maW5kT3B0aW9ucy5hY2wgPSB0aGlzLmZpbmRPcHRpb25zLmFjbC5jb25jYXQocm9sZXMsIFtcbiAgICAgICAgdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICBdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIENoYW5nZXMgdGhlIGNsYXNzTmFtZSBpZiByZWRpcmVjdENsYXNzTmFtZUZvcktleSBpcyBzZXQuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVkaXJlY3RDbGFzc05hbWVGb3JLZXkgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLnJlZGlyZWN0S2V5KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgLy8gV2UgbmVlZCB0byBjaGFuZ2UgdGhlIGNsYXNzIG5hbWUgYmFzZWQgb24gdGhlIHNjaGVtYVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAucmVkaXJlY3RDbGFzc05hbWVGb3JLZXkodGhpcy5jbGFzc05hbWUsIHRoaXMucmVkaXJlY3RLZXkpXG4gICAgLnRoZW4obmV3Q2xhc3NOYW1lID0+IHtcbiAgICAgIHRoaXMuY2xhc3NOYW1lID0gbmV3Q2xhc3NOYW1lO1xuICAgICAgdGhpcy5yZWRpcmVjdENsYXNzTmFtZSA9IG5ld0NsYXNzTmFtZTtcbiAgICB9KTtcbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbigpIHtcbiAgaWYgKFxuICAgIHRoaXMuY29uZmlnLmFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiA9PT0gZmFsc2UgJiZcbiAgICAhdGhpcy5hdXRoLmlzTWFzdGVyICYmXG4gICAgU2NoZW1hQ29udHJvbGxlci5zeXN0ZW1DbGFzc2VzLmluZGV4T2YodGhpcy5jbGFzc05hbWUpID09PSAtMVxuICApIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5sb2FkU2NoZW1hKClcbiAgICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5oYXNDbGFzcyh0aGlzLmNsYXNzTmFtZSkpXG4gICAgICAudGhlbihoYXNDbGFzcyA9PiB7XG4gICAgICAgIGlmIChoYXNDbGFzcyAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICAnVGhpcyB1c2VyIGlzIG5vdCBhbGxvd2VkIHRvIGFjY2VzcyAnICtcbiAgICAgICAgICAgICAgJ25vbi1leGlzdGVudCBjbGFzczogJyArXG4gICAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG5mdW5jdGlvbiB0cmFuc2Zvcm1JblF1ZXJ5KGluUXVlcnlPYmplY3QsIGNsYXNzTmFtZSwgcmVzdWx0cykge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiByZXN1bHRzKSB7XG4gICAgdmFsdWVzLnB1c2goe1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6IGNsYXNzTmFtZSxcbiAgICAgIG9iamVjdElkOiByZXN1bHQub2JqZWN0SWQsXG4gICAgfSk7XG4gIH1cbiAgZGVsZXRlIGluUXVlcnlPYmplY3RbJyRpblF1ZXJ5J107XG4gIGlmIChBcnJheS5pc0FycmF5KGluUXVlcnlPYmplY3RbJyRpbiddKSkge1xuICAgIGluUXVlcnlPYmplY3RbJyRpbiddID0gaW5RdWVyeU9iamVjdFsnJGluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgaW5RdWVyeU9iamVjdFsnJGluJ10gPSB2YWx1ZXM7XG4gIH1cbn1cblxuLy8gUmVwbGFjZXMgYSAkaW5RdWVyeSBjbGF1c2UgYnkgcnVubmluZyB0aGUgc3VicXVlcnksIGlmIHRoZXJlIGlzIGFuXG4vLyAkaW5RdWVyeSBjbGF1c2UuXG4vLyBUaGUgJGluUXVlcnkgY2xhdXNlIHR1cm5zIGludG8gYW4gJGluIHdpdGggdmFsdWVzIHRoYXQgYXJlIGp1c3Rcbi8vIHBvaW50ZXJzIHRvIHRoZSBvYmplY3RzIHJldHVybmVkIGluIHRoZSBzdWJxdWVyeS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZUluUXVlcnkgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGluUXVlcnlPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRpblF1ZXJ5Jyk7XG4gIGlmICghaW5RdWVyeU9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBpblF1ZXJ5IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSB3aGVyZSBhbmQgY2xhc3NOYW1lXG4gIHZhciBpblF1ZXJ5VmFsdWUgPSBpblF1ZXJ5T2JqZWN0WyckaW5RdWVyeSddO1xuICBpZiAoIWluUXVlcnlWYWx1ZS53aGVyZSB8fCAhaW5RdWVyeVZhbHVlLmNsYXNzTmFtZSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAnaW1wcm9wZXIgdXNhZ2Ugb2YgJGluUXVlcnknXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBpblF1ZXJ5VmFsdWUucmVkaXJlY3RDbGFzc05hbWVGb3JLZXksXG4gIH07XG5cbiAgaWYgKHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAodGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIHZhciBzdWJxdWVyeSA9IG5ldyBSZXN0UXVlcnkoXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5hdXRoLFxuICAgIGluUXVlcnlWYWx1ZS5jbGFzc05hbWUsXG4gICAgaW5RdWVyeVZhbHVlLndoZXJlLFxuICAgIGFkZGl0aW9uYWxPcHRpb25zXG4gICk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtSW5RdWVyeShpblF1ZXJ5T2JqZWN0LCBzdWJxdWVyeS5jbGFzc05hbWUsIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIFJlY3Vyc2UgdG8gcmVwZWF0XG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZUluUXVlcnkoKTtcbiAgfSk7XG59O1xuXG5mdW5jdGlvbiB0cmFuc2Zvcm1Ob3RJblF1ZXJ5KG5vdEluUXVlcnlPYmplY3QsIGNsYXNzTmFtZSwgcmVzdWx0cykge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiByZXN1bHRzKSB7XG4gICAgdmFsdWVzLnB1c2goe1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6IGNsYXNzTmFtZSxcbiAgICAgIG9iamVjdElkOiByZXN1bHQub2JqZWN0SWQsXG4gICAgfSk7XG4gIH1cbiAgZGVsZXRlIG5vdEluUXVlcnlPYmplY3RbJyRub3RJblF1ZXJ5J107XG4gIGlmIChBcnJheS5pc0FycmF5KG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXSkpIHtcbiAgICBub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10gPSBub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgbm90SW5RdWVyeU9iamVjdFsnJG5pbiddID0gdmFsdWVzO1xuICB9XG59XG5cbi8vIFJlcGxhY2VzIGEgJG5vdEluUXVlcnkgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhblxuLy8gJG5vdEluUXVlcnkgY2xhdXNlLlxuLy8gVGhlICRub3RJblF1ZXJ5IGNsYXVzZSB0dXJucyBpbnRvIGEgJG5pbiB3aXRoIHZhbHVlcyB0aGF0IGFyZSBqdXN0XG4vLyBwb2ludGVycyB0byB0aGUgb2JqZWN0cyByZXR1cm5lZCBpbiB0aGUgc3VicXVlcnkuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VOb3RJblF1ZXJ5ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBub3RJblF1ZXJ5T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckbm90SW5RdWVyeScpO1xuICBpZiAoIW5vdEluUXVlcnlPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgbm90SW5RdWVyeSB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gd2hlcmUgYW5kIGNsYXNzTmFtZVxuICB2YXIgbm90SW5RdWVyeVZhbHVlID0gbm90SW5RdWVyeU9iamVjdFsnJG5vdEluUXVlcnknXTtcbiAgaWYgKCFub3RJblF1ZXJ5VmFsdWUud2hlcmUgfHwgIW5vdEluUXVlcnlWYWx1ZS5jbGFzc05hbWUpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgJ2ltcHJvcGVyIHVzYWdlIG9mICRub3RJblF1ZXJ5J1xuICAgICk7XG4gIH1cblxuICBjb25zdCBhZGRpdGlvbmFsT3B0aW9ucyA9IHtcbiAgICByZWRpcmVjdENsYXNzTmFtZUZvcktleTogbm90SW5RdWVyeVZhbHVlLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9IGVsc2UgaWYgKHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICB2YXIgc3VicXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuYXV0aCxcbiAgICBub3RJblF1ZXJ5VmFsdWUuY2xhc3NOYW1lLFxuICAgIG5vdEluUXVlcnlWYWx1ZS53aGVyZSxcbiAgICBhZGRpdGlvbmFsT3B0aW9uc1xuICApO1xuICByZXR1cm4gc3VicXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgIHRyYW5zZm9ybU5vdEluUXVlcnkobm90SW5RdWVyeU9iamVjdCwgc3VicXVlcnkuY2xhc3NOYW1lLCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBSZWN1cnNlIHRvIHJlcGVhdFxuICAgIHJldHVybiB0aGlzLnJlcGxhY2VOb3RJblF1ZXJ5KCk7XG4gIH0pO1xufTtcblxuY29uc3QgdHJhbnNmb3JtU2VsZWN0ID0gKHNlbGVjdE9iamVjdCwga2V5LCBvYmplY3RzKSA9PiB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIG9iamVjdHMpIHtcbiAgICB2YWx1ZXMucHVzaChrZXkuc3BsaXQoJy4nKS5yZWR1Y2UoKG8sIGkpID0+IG9baV0sIHJlc3VsdCkpO1xuICB9XG4gIGRlbGV0ZSBzZWxlY3RPYmplY3RbJyRzZWxlY3QnXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkoc2VsZWN0T2JqZWN0WyckaW4nXSkpIHtcbiAgICBzZWxlY3RPYmplY3RbJyRpbiddID0gc2VsZWN0T2JqZWN0WyckaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBzZWxlY3RPYmplY3RbJyRpbiddID0gdmFsdWVzO1xuICB9XG59O1xuXG4vLyBSZXBsYWNlcyBhICRzZWxlY3QgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhXG4vLyAkc2VsZWN0IGNsYXVzZS5cbi8vIFRoZSAkc2VsZWN0IGNsYXVzZSB0dXJucyBpbnRvIGFuICRpbiB3aXRoIHZhbHVlcyBzZWxlY3RlZCBvdXQgb2Zcbi8vIHRoZSBzdWJxdWVyeS5cbi8vIFJldHVybnMgYSBwb3NzaWJsZS1wcm9taXNlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlU2VsZWN0ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBzZWxlY3RPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRzZWxlY3QnKTtcbiAgaWYgKCFzZWxlY3RPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgc2VsZWN0IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSBxdWVyeSBhbmQga2V5XG4gIHZhciBzZWxlY3RWYWx1ZSA9IHNlbGVjdE9iamVjdFsnJHNlbGVjdCddO1xuICAvLyBpT1MgU0RLIGRvbid0IHNlbmQgd2hlcmUgaWYgbm90IHNldCwgbGV0IGl0IHBhc3NcbiAgaWYgKFxuICAgICFzZWxlY3RWYWx1ZS5xdWVyeSB8fFxuICAgICFzZWxlY3RWYWx1ZS5rZXkgfHxcbiAgICB0eXBlb2Ygc2VsZWN0VmFsdWUucXVlcnkgIT09ICdvYmplY3QnIHx8XG4gICAgIXNlbGVjdFZhbHVlLnF1ZXJ5LmNsYXNzTmFtZSB8fFxuICAgIE9iamVjdC5rZXlzKHNlbGVjdFZhbHVlKS5sZW5ndGggIT09IDJcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICdpbXByb3BlciB1c2FnZSBvZiAkc2VsZWN0J1xuICAgICk7XG4gIH1cblxuICBjb25zdCBhZGRpdGlvbmFsT3B0aW9ucyA9IHtcbiAgICByZWRpcmVjdENsYXNzTmFtZUZvcktleTogc2VsZWN0VmFsdWUucXVlcnkucmVkaXJlY3RDbGFzc05hbWVGb3JLZXksXG4gIH07XG5cbiAgaWYgKHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAodGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIHZhciBzdWJxdWVyeSA9IG5ldyBSZXN0UXVlcnkoXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5hdXRoLFxuICAgIHNlbGVjdFZhbHVlLnF1ZXJ5LmNsYXNzTmFtZSxcbiAgICBzZWxlY3RWYWx1ZS5xdWVyeS53aGVyZSxcbiAgICBhZGRpdGlvbmFsT3B0aW9uc1xuICApO1xuICByZXR1cm4gc3VicXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgIHRyYW5zZm9ybVNlbGVjdChzZWxlY3RPYmplY3QsIHNlbGVjdFZhbHVlLmtleSwgcmVzcG9uc2UucmVzdWx0cyk7XG4gICAgLy8gS2VlcCByZXBsYWNpbmcgJHNlbGVjdCBjbGF1c2VzXG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZVNlbGVjdCgpO1xuICB9KTtcbn07XG5cbmNvbnN0IHRyYW5zZm9ybURvbnRTZWxlY3QgPSAoZG9udFNlbGVjdE9iamVjdCwga2V5LCBvYmplY3RzKSA9PiB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIG9iamVjdHMpIHtcbiAgICB2YWx1ZXMucHVzaChrZXkuc3BsaXQoJy4nKS5yZWR1Y2UoKG8sIGkpID0+IG9baV0sIHJlc3VsdCkpO1xuICB9XG4gIGRlbGV0ZSBkb250U2VsZWN0T2JqZWN0WyckZG9udFNlbGVjdCddO1xuICBpZiAoQXJyYXkuaXNBcnJheShkb250U2VsZWN0T2JqZWN0WyckbmluJ10pKSB7XG4gICAgZG9udFNlbGVjdE9iamVjdFsnJG5pbiddID0gZG9udFNlbGVjdE9iamVjdFsnJG5pbiddLmNvbmNhdCh2YWx1ZXMpO1xuICB9IGVsc2Uge1xuICAgIGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXSA9IHZhbHVlcztcbiAgfVxufTtcblxuLy8gUmVwbGFjZXMgYSAkZG9udFNlbGVjdCBjbGF1c2UgYnkgcnVubmluZyB0aGUgc3VicXVlcnksIGlmIHRoZXJlIGlzIGFcbi8vICRkb250U2VsZWN0IGNsYXVzZS5cbi8vIFRoZSAkZG9udFNlbGVjdCBjbGF1c2UgdHVybnMgaW50byBhbiAkbmluIHdpdGggdmFsdWVzIHNlbGVjdGVkIG91dCBvZlxuLy8gdGhlIHN1YnF1ZXJ5LlxuLy8gUmV0dXJucyBhIHBvc3NpYmxlLXByb21pc2UuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VEb250U2VsZWN0ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBkb250U2VsZWN0T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckZG9udFNlbGVjdCcpO1xuICBpZiAoIWRvbnRTZWxlY3RPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgZG9udFNlbGVjdCB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gcXVlcnkgYW5kIGtleVxuICB2YXIgZG9udFNlbGVjdFZhbHVlID0gZG9udFNlbGVjdE9iamVjdFsnJGRvbnRTZWxlY3QnXTtcbiAgaWYgKFxuICAgICFkb250U2VsZWN0VmFsdWUucXVlcnkgfHxcbiAgICAhZG9udFNlbGVjdFZhbHVlLmtleSB8fFxuICAgIHR5cGVvZiBkb250U2VsZWN0VmFsdWUucXVlcnkgIT09ICdvYmplY3QnIHx8XG4gICAgIWRvbnRTZWxlY3RWYWx1ZS5xdWVyeS5jbGFzc05hbWUgfHxcbiAgICBPYmplY3Qua2V5cyhkb250U2VsZWN0VmFsdWUpLmxlbmd0aCAhPT0gMlxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgJ2ltcHJvcGVyIHVzYWdlIG9mICRkb250U2VsZWN0J1xuICAgICk7XG4gIH1cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IGRvbnRTZWxlY3RWYWx1ZS5xdWVyeS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmICh0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LmNsYXNzTmFtZSxcbiAgICBkb250U2VsZWN0VmFsdWUucXVlcnkud2hlcmUsXG4gICAgYWRkaXRpb25hbE9wdGlvbnNcbiAgKTtcbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICB0cmFuc2Zvcm1Eb250U2VsZWN0KFxuICAgICAgZG9udFNlbGVjdE9iamVjdCxcbiAgICAgIGRvbnRTZWxlY3RWYWx1ZS5rZXksXG4gICAgICByZXNwb25zZS5yZXN1bHRzXG4gICAgKTtcbiAgICAvLyBLZWVwIHJlcGxhY2luZyAkZG9udFNlbGVjdCBjbGF1c2VzXG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZURvbnRTZWxlY3QoKTtcbiAgfSk7XG59O1xuXG5jb25zdCBjbGVhblJlc3VsdEF1dGhEYXRhID0gZnVuY3Rpb24ocmVzdWx0KSB7XG4gIGRlbGV0ZSByZXN1bHQucGFzc3dvcmQ7XG4gIGlmIChyZXN1bHQuYXV0aERhdGEpIHtcbiAgICBPYmplY3Qua2V5cyhyZXN1bHQuYXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgaWYgKHJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl0gPT09IG51bGwpIHtcbiAgICAgICAgZGVsZXRlIHJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAoT2JqZWN0LmtleXMocmVzdWx0LmF1dGhEYXRhKS5sZW5ndGggPT0gMCkge1xuICAgICAgZGVsZXRlIHJlc3VsdC5hdXRoRGF0YTtcbiAgICB9XG4gIH1cbn07XG5cbmNvbnN0IHJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQgPSBjb25zdHJhaW50ID0+IHtcbiAgaWYgKHR5cGVvZiBjb25zdHJhaW50ICE9PSAnb2JqZWN0Jykge1xuICAgIHJldHVybiBjb25zdHJhaW50O1xuICB9XG4gIGNvbnN0IGVxdWFsVG9PYmplY3QgPSB7fTtcbiAgbGV0IGhhc0RpcmVjdENvbnN0cmFpbnQgPSBmYWxzZTtcbiAgbGV0IGhhc09wZXJhdG9yQ29uc3RyYWludCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IGtleSBpbiBjb25zdHJhaW50KSB7XG4gICAgaWYgKGtleS5pbmRleE9mKCckJykgIT09IDApIHtcbiAgICAgIGhhc0RpcmVjdENvbnN0cmFpbnQgPSB0cnVlO1xuICAgICAgZXF1YWxUb09iamVjdFtrZXldID0gY29uc3RyYWludFtrZXldO1xuICAgIH0gZWxzZSB7XG4gICAgICBoYXNPcGVyYXRvckNvbnN0cmFpbnQgPSB0cnVlO1xuICAgIH1cbiAgfVxuICBpZiAoaGFzRGlyZWN0Q29uc3RyYWludCAmJiBoYXNPcGVyYXRvckNvbnN0cmFpbnQpIHtcbiAgICBjb25zdHJhaW50WyckZXEnXSA9IGVxdWFsVG9PYmplY3Q7XG4gICAgT2JqZWN0LmtleXMoZXF1YWxUb09iamVjdCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgZGVsZXRlIGNvbnN0cmFpbnRba2V5XTtcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gY29uc3RyYWludDtcbn07XG5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZUVxdWFsaXR5ID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0eXBlb2YgdGhpcy5yZXN0V2hlcmUgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3Qga2V5IGluIHRoaXMucmVzdFdoZXJlKSB7XG4gICAgdGhpcy5yZXN0V2hlcmVba2V5XSA9IHJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQodGhpcy5yZXN0V2hlcmVba2V5XSk7XG4gIH1cbn07XG5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGV0aGVyIGl0IHdhcyBzdWNjZXNzZnVsLlxuLy8gUG9wdWxhdGVzIHRoaXMucmVzcG9uc2Ugd2l0aCBhbiBvYmplY3QgdGhhdCBvbmx5IGhhcyAncmVzdWx0cycuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJ1bkZpbmQgPSBmdW5jdGlvbihvcHRpb25zID0ge30pIHtcbiAgaWYgKHRoaXMuZmluZE9wdGlvbnMubGltaXQgPT09IDApIHtcbiAgICB0aGlzLnJlc3BvbnNlID0geyByZXN1bHRzOiBbXSB9O1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICBjb25zdCBmaW5kT3B0aW9ucyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuZmluZE9wdGlvbnMpO1xuICBpZiAodGhpcy5rZXlzKSB7XG4gICAgZmluZE9wdGlvbnMua2V5cyA9IHRoaXMua2V5cy5tYXAoa2V5ID0+IHtcbiAgICAgIHJldHVybiBrZXkuc3BsaXQoJy4nKVswXTtcbiAgICB9KTtcbiAgfVxuICBpZiAob3B0aW9ucy5vcCkge1xuICAgIGZpbmRPcHRpb25zLm9wID0gb3B0aW9ucy5vcDtcbiAgfVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZCh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZXN0V2hlcmUsIGZpbmRPcHRpb25zLCB0aGlzLmF1dGgpXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAgICAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICAgICAgICBjbGVhblJlc3VsdEF1dGhEYXRhKHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgKHRoaXMuY29uZmlnLnF1ZXJ5TWlkZGxld2FyZSB8fCBbXSkuZm9yRWFjaCh3YXJlID0+IHJlc3VsdHMgPSB3YXJlKHRoaXMuY2xhc3NOYW1lLCByZXN1bHRzLCB0aGlzLmF1dGgpKTtcblxuICAgICAgdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QodGhpcy5jb25maWcsIHJlc3VsdHMpO1xuXG4gICAgICBpZiAodGhpcy5yZWRpcmVjdENsYXNzTmFtZSkge1xuICAgICAgICBmb3IgKHZhciByIG9mIHJlc3VsdHMpIHtcbiAgICAgICAgICByLmNsYXNzTmFtZSA9IHRoaXMucmVkaXJlY3RDbGFzc05hbWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHRoaXMucmVzcG9uc2UgPSB7IHJlc3VsdHM6IHJlc3VsdHMgfTtcbiAgICB9KTtcbn07XG5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGV0aGVyIGl0IHdhcyBzdWNjZXNzZnVsLlxuLy8gUG9wdWxhdGVzIHRoaXMucmVzcG9uc2UuY291bnQgd2l0aCB0aGUgY291bnRcblJlc3RRdWVyeS5wcm90b3R5cGUucnVuQ291bnQgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLmRvQ291bnQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhpcy5maW5kT3B0aW9ucy5jb3VudCA9IHRydWU7XG4gIGRlbGV0ZSB0aGlzLmZpbmRPcHRpb25zLnNraXA7XG4gIGRlbGV0ZSB0aGlzLmZpbmRPcHRpb25zLmxpbWl0O1xuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZCh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZXN0V2hlcmUsIHRoaXMuZmluZE9wdGlvbnMpXG4gICAgLnRoZW4oYyA9PiB7XG4gICAgICB0aGlzLnJlc3BvbnNlLmNvdW50ID0gYztcbiAgICB9KTtcbn07XG5cbi8vIEF1Z21lbnRzIHRoaXMucmVzcG9uc2Ugd2l0aCBhbGwgcG9pbnRlcnMgb24gYW4gb2JqZWN0XG5SZXN0UXVlcnkucHJvdG90eXBlLmhhbmRsZUluY2x1ZGVBbGwgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLmluY2x1ZGVBbGwpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmxvYWRTY2hlbWEoKVxuICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5nZXRPbmVTY2hlbWEodGhpcy5jbGFzc05hbWUpKVxuICAgIC50aGVuKHNjaGVtYSA9PiB7XG4gICAgICBjb25zdCBpbmNsdWRlRmllbGRzID0gW107XG4gICAgICBjb25zdCBrZXlGaWVsZHMgPSBbXTtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gc2NoZW1hLmZpZWxkcykge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSAmJlxuICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJ1xuICAgICAgICApIHtcbiAgICAgICAgICBpbmNsdWRlRmllbGRzLnB1c2goW2ZpZWxkXSk7XG4gICAgICAgICAga2V5RmllbGRzLnB1c2goZmllbGQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBBZGQgZmllbGRzIHRvIGluY2x1ZGUsIGtleXMsIHJlbW92ZSBkdXBzXG4gICAgICB0aGlzLmluY2x1ZGUgPSBbLi4ubmV3IFNldChbLi4udGhpcy5pbmNsdWRlLCAuLi5pbmNsdWRlRmllbGRzXSldO1xuICAgICAgLy8gaWYgdGhpcy5rZXlzIG5vdCBzZXQsIHRoZW4gYWxsIGtleXMgYXJlIGFscmVhZHkgaW5jbHVkZWRcbiAgICAgIGlmICh0aGlzLmtleXMpIHtcbiAgICAgICAgdGhpcy5rZXlzID0gWy4uLm5ldyBTZXQoWy4uLnRoaXMua2V5cywgLi4ua2V5RmllbGRzXSldO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuLy8gVXBkYXRlcyBwcm9wZXJ0eSBgdGhpcy5rZXlzYCB0byBjb250YWluIGFsbCBrZXlzIGJ1dCB0aGUgb25lcyB1bnNlbGVjdGVkLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVFeGNsdWRlS2V5cyA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMuZXhjbHVkZUtleXMpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHRoaXMua2V5cykge1xuICAgIHRoaXMua2V5cyA9IHRoaXMua2V5cy5maWx0ZXIoayA9PiAhdGhpcy5leGNsdWRlS2V5cy5pbmNsdWRlcyhrKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5sb2FkU2NoZW1hKClcbiAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuZ2V0T25lU2NoZW1hKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgY29uc3QgZmllbGRzID0gT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcyk7XG4gICAgICB0aGlzLmtleXMgPSBmaWVsZHMuZmlsdGVyKGsgPT4gIXRoaXMuZXhjbHVkZUtleXMuaW5jbHVkZXMoaykpO1xuICAgIH0pO1xufTtcblxuLy8gQXVnbWVudHMgdGhpcy5yZXNwb25zZSB3aXRoIGRhdGEgYXQgdGhlIHBhdGhzIHByb3ZpZGVkIGluIHRoaXMuaW5jbHVkZS5cblJlc3RRdWVyeS5wcm90b3R5cGUuaGFuZGxlSW5jbHVkZSA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5pbmNsdWRlLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIHBhdGhSZXNwb25zZSA9IGluY2x1ZGVQYXRoKFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuYXV0aCxcbiAgICB0aGlzLnJlc3BvbnNlLFxuICAgIHRoaXMuaW5jbHVkZVswXSxcbiAgICB0aGlzLnJlc3RPcHRpb25zXG4gICk7XG4gIGlmIChwYXRoUmVzcG9uc2UudGhlbikge1xuICAgIHJldHVybiBwYXRoUmVzcG9uc2UudGhlbihuZXdSZXNwb25zZSA9PiB7XG4gICAgICB0aGlzLnJlc3BvbnNlID0gbmV3UmVzcG9uc2U7XG4gICAgICB0aGlzLmluY2x1ZGUgPSB0aGlzLmluY2x1ZGUuc2xpY2UoMSk7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVJbmNsdWRlKCk7XG4gICAgfSk7XG4gIH0gZWxzZSBpZiAodGhpcy5pbmNsdWRlLmxlbmd0aCA+IDApIHtcbiAgICB0aGlzLmluY2x1ZGUgPSB0aGlzLmluY2x1ZGUuc2xpY2UoMSk7XG4gICAgcmV0dXJuIHRoaXMuaGFuZGxlSW5jbHVkZSgpO1xuICB9XG5cbiAgcmV0dXJuIHBhdGhSZXNwb25zZTtcbn07XG5cbi8vUmV0dXJucyBhIHByb21pc2Ugb2YgYSBwcm9jZXNzZWQgc2V0IG9mIHJlc3VsdHNcblJlc3RRdWVyeS5wcm90b3R5cGUucnVuQWZ0ZXJGaW5kVHJpZ2dlciA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMucmVzcG9uc2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYWZ0ZXJGaW5kJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBjb25zdCBoYXNBZnRlckZpbmRIb29rID0gdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlckZpbmQsXG4gICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICApO1xuICBpZiAoIWhhc0FmdGVyRmluZEhvb2spIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gU2tpcCBBZ2dyZWdhdGUgYW5kIERpc3RpbmN0IFF1ZXJpZXNcbiAgaWYgKHRoaXMuZmluZE9wdGlvbnMucGlwZWxpbmUgfHwgdGhpcy5maW5kT3B0aW9ucy5kaXN0aW5jdCkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBSdW4gYWZ0ZXJGaW5kIHRyaWdnZXIgYW5kIHNldCB0aGUgbmV3IHJlc3VsdHNcbiAgcmV0dXJuIHRyaWdnZXJzXG4gICAgLm1heWJlUnVuQWZ0ZXJGaW5kVHJpZ2dlcihcbiAgICAgIHRyaWdnZXJzLlR5cGVzLmFmdGVyRmluZCxcbiAgICAgIHRoaXMuYXV0aCxcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgdGhpcy5yZXNwb25zZS5yZXN1bHRzLFxuICAgICAgdGhpcy5jb25maWdcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAvLyBFbnN1cmUgd2UgcHJvcGVybHkgc2V0IHRoZSBjbGFzc05hbWUgYmFja1xuICAgICAgaWYgKHRoaXMucmVkaXJlY3RDbGFzc05hbWUpIHtcbiAgICAgICAgdGhpcy5yZXNwb25zZS5yZXN1bHRzID0gcmVzdWx0cy5tYXAob2JqZWN0ID0+IHtcbiAgICAgICAgICBpZiAob2JqZWN0IGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgICAgICBvYmplY3QgPSBvYmplY3QudG9KU09OKCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG9iamVjdC5jbGFzc05hbWUgPSB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lO1xuICAgICAgICAgIHJldHVybiBvYmplY3Q7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5yZXNwb25zZS5yZXN1bHRzID0gcmVzdWx0cztcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cbi8vIEFkZHMgaW5jbHVkZWQgdmFsdWVzIHRvIHRoZSByZXNwb25zZS5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkIG5hbWVzLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIGFuIGF1Z21lbnRlZCByZXNwb25zZS5cbmZ1bmN0aW9uIGluY2x1ZGVQYXRoKGNvbmZpZywgYXV0aCwgcmVzcG9uc2UsIHBhdGgsIHJlc3RPcHRpb25zID0ge30pIHtcbiAgdmFyIHBvaW50ZXJzID0gZmluZFBvaW50ZXJzKHJlc3BvbnNlLnJlc3VsdHMsIHBhdGgpO1xuICBpZiAocG9pbnRlcnMubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgcG9pbnRlcnNIYXNoID0ge307XG4gIGZvciAodmFyIHBvaW50ZXIgb2YgcG9pbnRlcnMpIHtcbiAgICBpZiAoIXBvaW50ZXIpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjbGFzc05hbWUgPSBwb2ludGVyLmNsYXNzTmFtZTtcbiAgICAvLyBvbmx5IGluY2x1ZGUgdGhlIGdvb2QgcG9pbnRlcnNcbiAgICBpZiAoY2xhc3NOYW1lKSB7XG4gICAgICBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXSA9IHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdIHx8IG5ldyBTZXQoKTtcbiAgICAgIHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdLmFkZChwb2ludGVyLm9iamVjdElkKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgaW5jbHVkZVJlc3RPcHRpb25zID0ge307XG4gIGlmIChyZXN0T3B0aW9ucy5rZXlzKSB7XG4gICAgY29uc3Qga2V5cyA9IG5ldyBTZXQocmVzdE9wdGlvbnMua2V5cy5zcGxpdCgnLCcpKTtcbiAgICBjb25zdCBrZXlTZXQgPSBBcnJheS5mcm9tKGtleXMpLnJlZHVjZSgoc2V0LCBrZXkpID0+IHtcbiAgICAgIGNvbnN0IGtleVBhdGggPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgIGxldCBpID0gMDtcbiAgICAgIGZvciAoaTsgaSA8IHBhdGgubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKHBhdGhbaV0gIT0ga2V5UGF0aFtpXSkge1xuICAgICAgICAgIHJldHVybiBzZXQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChpIDwga2V5UGF0aC5sZW5ndGgpIHtcbiAgICAgICAgc2V0LmFkZChrZXlQYXRoW2ldKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzZXQ7XG4gICAgfSwgbmV3IFNldCgpKTtcbiAgICBpZiAoa2V5U2V0LnNpemUgPiAwKSB7XG4gICAgICBpbmNsdWRlUmVzdE9wdGlvbnMua2V5cyA9IEFycmF5LmZyb20oa2V5U2V0KS5qb2luKCcsJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSkge1xuICAgIGluY2x1ZGVSZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgICBpbmNsdWRlUmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlID1cbiAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmIChyZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGluY2x1ZGVSZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgY29uc3QgcXVlcnlQcm9taXNlcyA9IE9iamVjdC5rZXlzKHBvaW50ZXJzSGFzaCkubWFwKGNsYXNzTmFtZSA9PiB7XG4gICAgY29uc3Qgb2JqZWN0SWRzID0gQXJyYXkuZnJvbShwb2ludGVyc0hhc2hbY2xhc3NOYW1lXSk7XG4gICAgbGV0IHdoZXJlO1xuICAgIGlmIChvYmplY3RJZHMubGVuZ3RoID09PSAxKSB7XG4gICAgICB3aGVyZSA9IHsgb2JqZWN0SWQ6IG9iamVjdElkc1swXSB9O1xuICAgIH0gZWxzZSB7XG4gICAgICB3aGVyZSA9IHsgb2JqZWN0SWQ6IHsgJGluOiBvYmplY3RJZHMgfSB9O1xuICAgIH1cbiAgICB2YXIgcXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgICAgY29uZmlnLFxuICAgICAgYXV0aCxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHdoZXJlLFxuICAgICAgaW5jbHVkZVJlc3RPcHRpb25zXG4gICAgKTtcbiAgICByZXR1cm4gcXVlcnkuZXhlY3V0ZSh7IG9wOiAnZ2V0JyB9KS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgcmVzdWx0cy5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHJlc3VsdHMpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBHZXQgdGhlIG9iamVjdHMgZm9yIGFsbCB0aGVzZSBvYmplY3QgaWRzXG4gIHJldHVybiBQcm9taXNlLmFsbChxdWVyeVByb21pc2VzKS50aGVuKHJlc3BvbnNlcyA9PiB7XG4gICAgdmFyIHJlcGxhY2UgPSByZXNwb25zZXMucmVkdWNlKChyZXBsYWNlLCBpbmNsdWRlUmVzcG9uc2UpID0+IHtcbiAgICAgIGZvciAodmFyIG9iaiBvZiBpbmNsdWRlUmVzcG9uc2UucmVzdWx0cykge1xuICAgICAgICBvYmouX190eXBlID0gJ09iamVjdCc7XG4gICAgICAgIG9iai5jbGFzc05hbWUgPSBpbmNsdWRlUmVzcG9uc2UuY2xhc3NOYW1lO1xuXG4gICAgICAgIGlmIChvYmouY2xhc3NOYW1lID09ICdfVXNlcicgJiYgIWF1dGguaXNNYXN0ZXIpIHtcbiAgICAgICAgICBkZWxldGUgb2JqLnNlc3Npb25Ub2tlbjtcbiAgICAgICAgICBkZWxldGUgb2JqLmF1dGhEYXRhO1xuICAgICAgICB9XG4gICAgICAgIHJlcGxhY2Vbb2JqLm9iamVjdElkXSA9IG9iajtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXBsYWNlO1xuICAgIH0sIHt9KTtcblxuICAgIHZhciByZXNwID0ge1xuICAgICAgcmVzdWx0czogcmVwbGFjZVBvaW50ZXJzKHJlc3BvbnNlLnJlc3VsdHMsIHBhdGgsIHJlcGxhY2UpLFxuICAgIH07XG4gICAgaWYgKHJlc3BvbnNlLmNvdW50KSB7XG4gICAgICByZXNwLmNvdW50ID0gcmVzcG9uc2UuY291bnQ7XG4gICAgfVxuICAgIHJldHVybiByZXNwO1xuICB9KTtcbn1cblxuLy8gT2JqZWN0IG1heSBiZSBhIGxpc3Qgb2YgUkVTVC1mb3JtYXQgb2JqZWN0IHRvIGZpbmQgcG9pbnRlcnMgaW4sIG9yXG4vLyBpdCBtYXkgYmUgYSBzaW5nbGUgb2JqZWN0LlxuLy8gSWYgdGhlIHBhdGggeWllbGRzIHRoaW5ncyB0aGF0IGFyZW4ndCBwb2ludGVycywgdGhpcyB0aHJvd3MgYW4gZXJyb3IuXG4vLyBQYXRoIGlzIGEgbGlzdCBvZiBmaWVsZHMgdG8gc2VhcmNoIGludG8uXG4vLyBSZXR1cm5zIGEgbGlzdCBvZiBwb2ludGVycyBpbiBSRVNUIGZvcm1hdC5cbmZ1bmN0aW9uIGZpbmRQb2ludGVycyhvYmplY3QsIHBhdGgpIHtcbiAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgdmFyIGFuc3dlciA9IFtdO1xuICAgIGZvciAodmFyIHggb2Ygb2JqZWN0KSB7XG4gICAgICBhbnN3ZXIgPSBhbnN3ZXIuY29uY2F0KGZpbmRQb2ludGVycyh4LCBwYXRoKSk7XG4gICAgfVxuICAgIHJldHVybiBhbnN3ZXI7XG4gIH1cblxuICBpZiAodHlwZW9mIG9iamVjdCAhPT0gJ29iamVjdCcgfHwgIW9iamVjdCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIGlmIChwYXRoLmxlbmd0aCA9PSAwKSB7XG4gICAgaWYgKG9iamVjdCA9PT0gbnVsbCB8fCBvYmplY3QuX190eXBlID09ICdQb2ludGVyJykge1xuICAgICAgcmV0dXJuIFtvYmplY3RdO1xuICAgIH1cbiAgICByZXR1cm4gW107XG4gIH1cblxuICB2YXIgc3Vib2JqZWN0ID0gb2JqZWN0W3BhdGhbMF1dO1xuICBpZiAoIXN1Ym9iamVjdCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICByZXR1cm4gZmluZFBvaW50ZXJzKHN1Ym9iamVjdCwgcGF0aC5zbGljZSgxKSk7XG59XG5cbi8vIE9iamVjdCBtYXkgYmUgYSBsaXN0IG9mIFJFU1QtZm9ybWF0IG9iamVjdHMgdG8gcmVwbGFjZSBwb2ludGVyc1xuLy8gaW4sIG9yIGl0IG1heSBiZSBhIHNpbmdsZSBvYmplY3QuXG4vLyBQYXRoIGlzIGEgbGlzdCBvZiBmaWVsZHMgdG8gc2VhcmNoIGludG8uXG4vLyByZXBsYWNlIGlzIGEgbWFwIGZyb20gb2JqZWN0IGlkIC0+IG9iamVjdC5cbi8vIFJldHVybnMgc29tZXRoaW5nIGFuYWxvZ291cyB0byBvYmplY3QsIGJ1dCB3aXRoIHRoZSBhcHByb3ByaWF0ZVxuLy8gcG9pbnRlcnMgaW5mbGF0ZWQuXG5mdW5jdGlvbiByZXBsYWNlUG9pbnRlcnMob2JqZWN0LCBwYXRoLCByZXBsYWNlKSB7XG4gIGlmIChvYmplY3QgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgIHJldHVybiBvYmplY3RcbiAgICAgIC5tYXAob2JqID0+IHJlcGxhY2VQb2ludGVycyhvYmosIHBhdGgsIHJlcGxhY2UpKVxuICAgICAgLmZpbHRlcihvYmogPT4gdHlwZW9mIG9iaiAhPT0gJ3VuZGVmaW5lZCcpO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBvYmplY3QgIT09ICdvYmplY3QnIHx8ICFvYmplY3QpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgaWYgKHBhdGgubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKG9iamVjdCAmJiBvYmplY3QuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgIHJldHVybiByZXBsYWNlW29iamVjdC5vYmplY3RJZF07XG4gICAgfVxuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cblxuICB2YXIgc3Vib2JqZWN0ID0gb2JqZWN0W3BhdGhbMF1dO1xuICBpZiAoIXN1Ym9iamVjdCkge1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cbiAgdmFyIG5ld3N1YiA9IHJlcGxhY2VQb2ludGVycyhzdWJvYmplY3QsIHBhdGguc2xpY2UoMSksIHJlcGxhY2UpO1xuICB2YXIgYW5zd2VyID0ge307XG4gIGZvciAodmFyIGtleSBpbiBvYmplY3QpIHtcbiAgICBpZiAoa2V5ID09IHBhdGhbMF0pIHtcbiAgICAgIGFuc3dlcltrZXldID0gbmV3c3ViO1xuICAgIH0gZWxzZSB7XG4gICAgICBhbnN3ZXJba2V5XSA9IG9iamVjdFtrZXldO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYW5zd2VyO1xufVxuXG4vLyBGaW5kcyBhIHN1Ym9iamVjdCB0aGF0IGhhcyB0aGUgZ2l2ZW4ga2V5LCBpZiB0aGVyZSBpcyBvbmUuXG4vLyBSZXR1cm5zIHVuZGVmaW5lZCBvdGhlcndpc2UuXG5mdW5jdGlvbiBmaW5kT2JqZWN0V2l0aEtleShyb290LCBrZXkpIHtcbiAgaWYgKHR5cGVvZiByb290ICE9PSAnb2JqZWN0Jykge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAocm9vdCBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgZm9yICh2YXIgaXRlbSBvZiByb290KSB7XG4gICAgICBjb25zdCBhbnN3ZXIgPSBmaW5kT2JqZWN0V2l0aEtleShpdGVtLCBrZXkpO1xuICAgICAgaWYgKGFuc3dlcikge1xuICAgICAgICByZXR1cm4gYW5zd2VyO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBpZiAocm9vdCAmJiByb290W2tleV0pIHtcbiAgICByZXR1cm4gcm9vdDtcbiAgfVxuICBmb3IgKHZhciBzdWJrZXkgaW4gcm9vdCkge1xuICAgIGNvbnN0IGFuc3dlciA9IGZpbmRPYmplY3RXaXRoS2V5KHJvb3Rbc3Via2V5XSwga2V5KTtcbiAgICBpZiAoYW5zd2VyKSB7XG4gICAgICByZXR1cm4gYW5zd2VyO1xuICAgIH1cbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IFJlc3RRdWVyeTtcbiJdfQ==