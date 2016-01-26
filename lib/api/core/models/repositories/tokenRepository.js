module.exports = function (kuzzle) {
  var
    _ = require('lodash'),
    jwt = require('jsonwebtoken'),
    ms = require('ms'),
    q = require('q'),
    Token = require('../security/token'),
    Repository = require('./repository'),
    InternalError = require('../../errors/internalError'),
    UnauthorizedError = require('../../errors/unauthorizedError');

  function parseTimespan(time) {
    var milliseconds;

    if (typeof time === 'string') {
      milliseconds = ms(time);

      if (typeof milliseconds === 'undefined') {
        return -1;
      }

      return milliseconds;
    }
    else if (typeof time === 'number') {
      return time;
    }

    return -1;
  }

  function TokenRepository (opts) {
    var options = opts || {};

    if (options.ttl !== undefined) {
      this.ttl = options.ttl;
    }
  }

  TokenRepository.prototype = new Repository(kuzzle, {
    index: '%kuzzle',
    collection: 'token',
    ObjectConstructor: Token,
    cacheEngine: kuzzle.services.list.tokenCache,
    readEngine: null
  });

  TokenRepository.prototype.expire = function(token) {
    var
      error,
      deferred = q.defer();

    Repository.prototype.expireFromCache.call(this, token)
      .then(() => {
        kuzzle.hotelClerk.tokenizedConnectionsController.expire(token);

        deferred.resolve();
      })
      .catch(err => {
        error = new InternalError('Error expiring token');
        error.details = err;

        deferred.reject(error);
      });

    return deferred.promise;
  };

  TokenRepository.prototype.generateToken = function (user, context, opts) {
    var
      expiresIn,
      token = new Token(),
      deferred = q.defer(),
      options = opts || {},
      encodedToken,
      error;

    if (!user || user._id === null) {
      error = new InternalError('Unknown User : cannot generate token');
      deferred.reject(error);
      return deferred.promise;
    }

    if (!context || context.connection === null) {
      error = new InternalError('Unknown context connection : cannot generate token');
      deferred.reject(error);
      return deferred.promise;
    }

    if (!options.algorithm) {
      options.algorithm = kuzzle.config.jsonWebToken.algorithm;
    }
    if (!options.expiresIn) {
      options.expiresIn = kuzzle.config.jsonWebToken.expiresIn;
    }

    try {
      expiresIn = parseTimespan(options.expiresIn);
      encodedToken = jwt.sign({_id: user._id}, kuzzle.config.jsonWebToken.secret, options);

      this.hydrate(token, {
        _id: encodedToken,
        user: user._id,
        ttl: expiresIn,
        expiresAt: Date.now() + expiresIn
      })
      .then((result) => {
        this.persistToCache(result);

        kuzzle.hotelClerk.tokenizedConnectionsController.add(result, context);

        deferred.resolve(result);
      })
      .catch((err) => {
        error = new InternalError('Error while saving token');
        error.details = err;

        deferred.reject(error);
      });
    }
    catch (err) {
      error = new InternalError('Error while generating token');
      error.details = err;
      deferred.reject(error);
    }

    return deferred.promise;
  };

  TokenRepository.prototype.verifyToken = function (token) {
    var
      deferred = q.defer(),
      decodedToken,
      error;

    if (token === null) {
      return this.anonymous();
    }

    try {
      decodedToken = jwt.verify(token, kuzzle.config.jsonWebToken.secret);

      if (decodedToken._id === 'admin') {
        return this.admin();
      }

      this.load(token)
        .then(userToken => {
          if (userToken === null) {
            error = new UnauthorizedError('Invalid token', 401);
            deferred.reject(error);
            return deferred;
          }

          deferred.resolve(userToken);
        })
        .catch(function (err) {
          error = new InternalError('Unknown user');
          error.details = err;

          deferred.reject(error);
        });
    }
    catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        error = new UnauthorizedError('Token expired', 401);
        error.details = {
          subCode: error.subCodes.TokenExpired,
          expiredAt: err.expiredAt
        };
      }
      else if (err instanceof jwt.JsonWebTokenError) {
        error = new UnauthorizedError('Json Web Token Error', 401);
        error.details = {
          subCode: error.subCodes.JsonWebTokenError,
          description: err.message
        };
      }
      else {
        error = new InternalError('Error verifying token');
        error.details = err;
      }

      deferred.reject(error);
    }

    return deferred.promise;
  };

  TokenRepository.prototype.hydrate = function (userToken, data) {
    var
      deferred = q.defer(),
      result;

    if (!_.isObject(data)) {
      return Promise.resolve(userToken);
    }

    Repository.prototype.hydrate(userToken, data)
      .then(t => {
        result = t;

        if (!t.user || t.user === undefined || t.user === null) {
          t._id = undefined;
          return kuzzle.repositories.user.anonymous();
        }

        return kuzzle.repositories.user.load(t.user);
      })
      .then(function (user) {
        result.user = user;
        deferred.resolve(result);
      })
      .catch(function (error) {
        deferred.reject(error);
      });

    return deferred.promise;
  };

  TokenRepository.prototype.serializeToCache = function (token) {
    var result = {};

    Object.keys(token).forEach(function (key) {
      if (key !== 'user') {
        result[key] = token[key];
      }
    });
    result.user = token.user._id;

    return result;
  };

  TokenRepository.prototype.anonymous = function () {
    var
      deferred = q.defer(),
      token = new Token();

    token._id = undefined;

    kuzzle.repositories.user.anonymous()
      .then(user => {
        token.user = user;
        deferred.resolve(token);
      })
      .catch(error => deferred.reject(error));

    return deferred.promise;
  };

  TokenRepository.prototype.admin = function () {
    var
      deferred = q.defer(),
      token = new Token();

    token._id = undefined;

    kuzzle.repositories.user.admin()
      .then(user => {
        token.user = user;
        deferred.resolve(token);
      })
      .catch(error => deferred.reject(error));

    return deferred.promise;
  };

  TokenRepository.prototype.serializeToDatabase = TokenRepository.prototype.serializeToCache;

  return TokenRepository;
};
