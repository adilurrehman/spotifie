'use strict';

/**
 * A very small in-memory stand-in for IndexedDB.
 *
 * Enough of the API for js/libraryDB.js to run under node:test: object stores
 * with a keyPath, indexes read with getAll(value), and transactions that
 * report completion. Requests call their handlers on the next tick, as the
 * browser does, so ordering bugs still show up.
 */

function later(fn) {
    setImmediate(fn);
}

function makeRequest() {
    const request = { onsuccess: null, onerror: null, result: undefined, error: null };
    return request;
}

class FakeIndex {
    constructor(store, keyPath) {
        this.store = store;
        this.keyPath = keyPath;
    }

    getAll(value) {
        const request = makeRequest();
        later(() => {
            request.result = Array.from(this.store.records.values()).filter(
                (record) => record[this.keyPath] === value
            );
            if (request.onsuccess) request.onsuccess();
        });
        return request;
    }
}

class FakeObjectStore {
    constructor(name, keyPath, transaction) {
        this.name = name;
        this.keyPath = keyPath;
        this.records = new Map();
        this.indexes = new Map();
        this.transaction = transaction || null;
    }

    createIndex(name, keyPath) {
        this.indexes.set(name, keyPath);
        return new FakeIndex(this, keyPath);
    }

    index(name) {
        return new FakeIndex(this, this.indexes.get(name) || name);
    }

    put(value) {
        const request = makeRequest();
        this._work(request, () => {
            this.records.set(value[this.keyPath], JSON.parse(JSON.stringify(value)));
            request.result = value[this.keyPath];
        });
        return request;
    }

    get(key) {
        const request = makeRequest();
        this._work(request, () => {
            request.result = this.records.get(key) || undefined;
        });
        return request;
    }

    delete(key) {
        const request = makeRequest();
        this._work(request, () => {
            this.records.delete(key);
        });
        return request;
    }

    getAll() {
        const request = makeRequest();
        this._work(request, () => {
            request.result = Array.from(this.records.values());
        });
        return request;
    }

    count() {
        const request = makeRequest();
        this._work(request, () => {
            request.result = this.records.size;
        });
        return request;
    }

    clear() {
        const request = makeRequest();
        this._work(request, () => {
            this.records.clear();
        });
        return request;
    }

    _work(request, apply) {
        if (this.transaction) this.transaction.pending += 1;
        later(() => {
            apply();
            if (request.onsuccess) request.onsuccess();
            if (this.transaction) this.transaction.settle();
        });
    }
}

class FakeTransaction {
    constructor(database, names) {
        this.database = database;
        this.names = names;
        this.pending = 0;
        this.oncomplete = null;
        this.onerror = null;
        this.error = null;
        this.finished = false;

        // A transaction with no work still completes.
        later(() => this.settle());
    }

    objectStore(name) {
        const store = this.database.stores.get(name);
        // The live store, bound to this transaction so it can count its work.
        store.transaction = this;
        return store;
    }

    settle() {
        if (this.pending > 0) this.pending -= 1;
        if (this.pending === 0 && !this.finished) {
            this.finished = true;
            if (this.oncomplete) this.oncomplete();
        }
    }
}

class FakeDatabase {
    constructor() {
        this.stores = new Map();
        this.objectStoreNames = {
            contains: (name) => this.stores.has(name)
        };
    }

    createObjectStore(name, options) {
        const store = new FakeObjectStore(name, (options && options.keyPath) || 'id', null);
        this.stores.set(name, store);
        return store;
    }

    transaction(names) {
        return new FakeTransaction(this, Array.isArray(names) ? names : [names]);
    }
}

/** Install a fresh empty database as globalThis.indexedDB. */
function installFakeIndexedDB() {
    const database = new FakeDatabase();

    globalThis.indexedDB = {
        open() {
            const request = { onsuccess: null, onerror: null, onupgradeneeded: null, result: database };
            later(() => {
                if (request.onupgradeneeded) request.onupgradeneeded({ target: { result: database } });
                if (request.onsuccess) request.onsuccess();
            });
            return request;
        }
    };

    return database;
}

module.exports = { installFakeIndexedDB };
