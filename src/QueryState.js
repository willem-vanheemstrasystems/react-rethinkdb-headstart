import {findIndex, isCursor, updateComponent} from './util.js';

// A QueryState represents the state of a single RethinkDB query, which may be
// shared among multiple components subscribing to the same data. It keeps
// track of the query results, the active cursors, the subscriptions from the
// active QueryRequests, and the loading and error status.
//
// The constructor takes an QueryRequest from the components interested in
// this query, a runQuery function from the Session, an onUpdate handler
// function that is called when any QueryResults/components have updated,
// and an onCloseQueryState handler function that is called when this
// QueryState is closed (when the last component has unsubscribed).
//
// The subscribe method registers a component and its corresponding
// QueryResult so that the component will have access to the query results.
// It returns an object with an unsubscribe() method to be called when the
// component is no longer interested in this query.
export class QueryState {
  constructor(queryRequest, runQuery, onUpdate, onCloseQueryState) {
    this.value = undefined;
    this.loading = true;
    this.errors = [];

    this.lastSubscriptionId = 0;
    this.subscriptions = {};
    this.updateHandler = onUpdate;
    this.closeHandlers = [onCloseQueryState];
    this.queryRequest = queryRequest;
    this.runQuery = runQuery;
  }

  handleConnect() {
    if (this.loading || this.queryRequest.changes) {
      this.loading = true;
      this.errors = [];
      if (this.queryRequest.changes) {
        this._runChangeQuery(this.queryRequest.query, this.runQuery);
      } else {
        this._runStaticQuery(this.queryRequest.query, this.runQuery);
      }
    }
  }

  subscribe(component, queryResult) {
    this._initQueryResult(queryResult);
    const subscriptionId = ++this.lastSubscriptionId;
    this.subscriptions[subscriptionId] = {queryResult, component};
    const unsubscribe = () => {
      delete this.subscriptions[subscriptionId];
      if (!Object.keys(this.subscriptions).length) {
        this.closeHandlers.forEach(handler => handler());
      }
    };
    return {unsubscribe};
  }

  _runStaticQuery(query, runQuery) {
    const promise = runQuery(query);
    this.closeHandlers.push(() => promise.then(x => isCursor(x) && x.close()));
    promise.then(cursor => {
      if (isCursor(cursor)) {
        cursor.toArray().then(result => {
          this._updateValue(result);
        });
      } else {
        this._updateValue(cursor);
      }
    }, error => {
      this._addError(error);
    });
  }

  _runChangeQuery(query, runQuery) {
    const changeQuery = query.changes({includeStates: true, includeInitial: true});
    const promise = runQuery(changeQuery);
    this.closeHandlers.push(() => promise.then(x => isCursor(x) && x.close()));
    promise.then(cursor => {
      const isPointFeed = cursor.constructor.name === 'AtomFeed';
      this.value = isPointFeed ? undefined : [];
      cursor.each((error, row) => {
        if (error) {
          this._addError(error);
        } else {
          if (row.state) {
            if (row.state === 'ready') {
              this.loading = false;
              this._updateSubscriptions();
            }
          } else {
            this._applyChangeDelta(row.old_val, row.new_val);
          }
        }
      });
    }, error => {
      if (error.msg === 'Unrecognized optional argument `include_initial`.') {
        console.error('react-rethinkdb requires rethinkdb >= 2.2 on backend');
      }
      this._addError(error);
    });
  }

  _initQueryResult(queryResult) {
    if (this.loading) {
      queryResult._reset();
    } else {
      queryResult._setValue(this.value);
    }
    queryResult._setErrors(this.errors);
  }

  _updateSubscriptions() {
    Object.keys(this.subscriptions).forEach(subscriptionId => {
      const subscription = this.subscriptions[subscriptionId];
      subscription.queryResult._setValue(this.value);
      subscription.queryResult._setErrors(this.errors);
      updateComponent(subscription.component);
    });
    this.updateHandler();
  }

  _addError(error) {
    console.error(error.stack || error.message || error);
    this.errors.push(error);
    this._updateSubscriptions();
  }

  _updateValue(value) {
    this.loading = false;
    this.value = value;
    this._updateSubscriptions();
  }

  _applyChangeDelta(oldVal, newVal) {
    if (Array.isArray(this.value)) {
      // TODO Make more efficient, with O(1) hashtables with cached
      // JSON.stringify keys. But this may not be necessary after RethinkDB
      // #3714 is implemented, since the server should give us the indices.
      let oldIndex = -1;
      if (oldVal) {
        const lookup = JSON.stringify(oldVal);
        oldIndex = findIndex(this.value, x => JSON.stringify(x) === lookup);
      }
      if (oldIndex < 0) {
        if (newVal) {
          this.value.push(newVal);
        } else {
          throw new Error('Change delta deleted nonexistent element');
        }
      } else {
        if (newVal) {
          this.value[oldIndex] = newVal;
        } else {
          this.value.splice(oldIndex, 1);
        }
      }
    } else {
      this.value = newVal;
    }
    if (!this.loading) {
      this._updateSubscriptions();
    }
  }
}
