'use strict';


/**
 * Database design and considerations
 *
 * 1. Revision table.
 * Item content, as fetched from the server, is stored as a `revision`.
 * Revisions are immutable. For now there's only one revision per entry,
 * but this may change in the future.
 *
 * 2. Entry table.
 * An entry is an item from a feed.
 */
// IndexedDB does not play nice with `async` (transaction ends before execution restarts)
// and the same problem with native Promise
// mb1193394, worked on around Fx58 nightly
let Database = {
    _db: null,
    db() {
        return this._db;
    },

    _feeds: [],
    get feeds() {
        return this._feeds;
    },

    async init() {
        if(this._db)
            return;
        let {storage} = await browser.storage.local.get({storage: 'persistent'});
        console.log(`Brief: opening database in ${storage} storage`);
        let openOptions = {version: 30};
        if(storage === 'persistent') {
            openOptions.storage = 'persistent';
        }
        let opener = indexedDB.open("brief", openOptions);
        opener.onupgradeneeded = (event) => this.upgrade(event);
        let request = await this._requestPromise(opener);
        this._db = request.result;
        this.loadFeeds();
        let entryCount = (await this.listEntries()).length;//FIXME
        console.log(`Brief: opened database with ${entryCount} entries`);
        //TODO watch feed list changes
    },

    upgrade(event) {
        console.log(`upgrade from version ${event.oldVersion}`);
        let {result: db, transaction: tx} = event.target;
        let revisions;
        let entries;
        switch(event.oldVersion) {
            case 0:
                revisions = db.createObjectStore("revisions", {
                    keyPath: "id", autoIncrement: true});
                // There could be a full-text index here, but let's avoid this
                entries = db.createObjectStore("entries", {
                    keyPath: "id", autoIncrement: true});
                entries.createIndex("date", "date");
                entries.createIndex("feedID_date", ["feedID", "date"]);
                entries.createIndex("primaryHash", "primaryHash"); // TODO: drop/update
                entries.createIndex("bookmarkID", "bookmarkID");
                entries.createIndex("entryURL", "entryURL");
                entries.createIndex("tagName", "tags", {multiEntry: true});
            // fallthrough
            case 10:
                let feeds = db.createObjectStore("feeds", {
                    keyPath: "feedID", autoIncrement: true});
                // No indices needed - the feed list is always loaded to memory
            // fallthrough
            case 20:
                entries = tx.objectStore('entries');
                // Enables quick unread filtering
                entries.createIndex(
                    'deleted_read_feedID_date',
                    ['deleted', 'read', 'feedID', 'date']);
                // Sorry, will have to rewrite everything as boolean keys can't be indexed
                let cursor = entries.openCursor();
                cursor.onsuccess = ({target}) => {
                    let cursor = target.result;
                    if(cursor) {
                        let value = cursor.value;
                        value.read = value.read ? 1 : 0;
                        cursor.update(value);
                        cursor.continue();
                    }
                };
            // fallthrough
        }
    },

    ENTRY_FIELDS: [
        'id', 'feedID',
        'read', 'markedUnreadOnUpdate', 'starred', 'tags', 'deleted',
        'providedID', 'entryURL', 'primaryHash', 'secondaryHash',
        'date',
    ],
    REVISION_FIELDS: ['id', 'authors', 'title', 'content', 'updated'],

    _putEntry(origEntry, tx) {
        let entry = {};
        let revision = {};

        for(let name of this.ENTRY_FIELDS) {
            entry[name] = origEntry[name];
        }
        entry.revisions = [{id: origEntry.id}]
        for(let name of this.REVISION_FIELDS) {
            revision[name] = origEntry[name];
        }
        entry.bookmarked = (origEntry.bookmarkID !== -1);
        entry.tags = (entry.tags || '').split(', ');

        tx.objectStore('revisions').put(revision);
        tx.objectStore('entries').put(entry);
    },

    query(filters) {
        if(filters === undefined) {
            filters = {};
        }
        return new Query(filters);
    },

    async putEntries(entries) {
        console.log(`Inserting ${entries.length} entries`);
        let tx = this._db.transaction(['revisions', 'entries'], 'readwrite');
        for(let entry of entries) {
            this._putEntry(entry, tx);
        }
        await this._transactionPromise(tx);
        console.log('Done inserting');
    },

    async deleteEntries(entries) {
        console.log(`Deleting ${entries.length} entries`);
        let tx = this._db.transaction(['revisions', 'entries'], 'readwrite');
        for(let entry of entries) {
            tx.objectStore('revisions').delete(entry);
            tx.objectStore('entries').delete(entry);
        }
        await this._transactionPromise(tx);
        console.log(`${entries.length} entries deleted`);
    },

    async clearEntries() {
        console.log(`Clearing the entries database`);
        let tx = this._db.transaction(['revisions', 'entries'], 'readwrite');
        tx.objectStore('revisions').clear();
        tx.objectStore('entries').clear();
        await this._transactionPromise(tx);
        console.log(`Databases cleared`);
    },

    async listEntries() {
        let tx = this._db.transaction(['entries']);
        let request = tx.objectStore('entries').getAllKeys();
        return (await this._requestPromise(request)).result;
    },

    async loadFeeds() {
        let tx = this._db.transaction(['feeds']);
        let request = tx.objectStore('feeds').getAll();
        let feeds = (await this._requestPromise(request)).result;
        console.log(`Brief: ${feeds.length} feeds in database`);

        if(feeds.length === 0) {
            console.log(`Brief: the database looks empty, testing backups`);
            ({feeds} = await browser.storage.local.get({feeds}));
            console.log(`Brief: ${feeds.length} feeds found in local storage`);
            if(feeds.length === 0) {
                ({feeds} = await browser.storage.sync.get({feeds}));
                console.log(`Brief: ${feeds.length} feeds found in sync storage`);
            }
            this.saveFeeds(feeds);
        }

        this._feeds = feeds;
    },

    async saveFeeds(feeds) {
        if(this._db === null) {
            return;
        }
        let tx = this._db.transaction(['feeds'], 'readwrite');
        tx.objectStore('feeds').clear();
        for(let feed of feeds) {
            tx.objectStore('feeds').put(feed);
        }
        await this._transactionPromise(tx);
        await this._saveFeedBackups(feeds);
        console.log(`Brief: saved feed list with ${feeds.length} feeds`);
    },

    async _saveFeedBackups(feeds) {
        let minimizedFeeds = [];
        for(let feed of feeds) {
            let minimized = Object.assign({}, feed);
            for(let key of Object.getOwnPropertyNames(minimized)) {
                if(key === 'favicon')
                    delete minimized.favicon;
                if(minimized[key] === null)
                    delete minimized[key];
            }
            minimizedFeeds.push(minimized);
        }
        feeds = minimizedFeeds;
        let store_local = browser.storage.local.set({feeds});
        let store_sync = browser.storage.sync.set({feeds});
        await Promise.all([store_local, store_sync]);
    },

    // Note: this is resolved after the transaction is finished(!!!) mb1193394
    _requestPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = (event) => resolve(event.target);
            req.onerror = (event) => reject(event.target);
        });
    },

    // Note: this is resolved after the transaction is finished(!)
    _transactionPromise(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = reject;
        });
    },
};


function Query(filters) {
    Object.assign(this, filters);
};

Query.prototype = {

    /**
     * Array of IDs of entries to be selected.
     */
    entries: undefined,

    /**
     * Array of IDs of feeds containing the entries to be selected.
     */
    feeds: undefined,

    /**
     * Array of IDs of folders containing the entries to be selected.
     */
    folders: undefined,

    /**
     * Array of tags which selected entries must have.
     */
    tags: undefined,

    /**
     * Read state of entries to be selected.
     */
    read: undefined,

    /**
     * Starred state of entries to be selected.
     */
    starred: undefined,

    /**
     * Deleted state of entries to be selected. See constants in StorageInternal.
     */
    deleted: undefined,

    /**
     * String that must be contained by title, content, authors or tags of the
     * selected entries.
     */
    searchString: undefined,

    /**
     * Date range for the selected entries.
     */
    startDate: undefined,
    endDate: undefined,

    /**
     * Maximum number of entries to be selected.
     */
    limit: undefined,

    /**
     * Specifies how many result entries to skip at the beggining of the result set.
     */
    offset: 0,

    /**
     * Direction in which to sort the results (order is always 'date').
     */
    sortDirection: 'desc',

    /**
     * Include hidden feeds i.e. the ones whose Live Bookmarks are no longer
     * to be found in Brief's home folder. This attribute is ignored if
     * the list of feeds is explicitly specified by Query.feeds.
     */
    includeHiddenFeeds: false,

     /**
     * Include feeds that the user marked as excluded from global views.
     */
    includeFeedsExcludedFromGlobalViews: true,

    async count() {
        await Database.init();
        let filters = this._filters();
        console.log("Brief: count query", filters);
        let {indexName, filterFunction, ranges} = this._searchEngine(filters);

        let offset = filters.sort.offset || 0;
        let limit = (filters.sort.limit === undefined) ? Number('Infinity') : filters.sort.limit;

        let answer = 0;
        let tx = Database.db().transaction(['entries'], 'readonly');
        let store = tx.objectStore('entries');
        let req = store.index(indexName).openCursor(ranges[0]);
        let totalCallbacks = 0;
        req.onsuccess = ({target}) => {
            let cursor = target.result;
            if(cursor) {
                totalCallbacks += 1;
                if(limit <= 0) {
                    return;
                }
                let cmp = filterFunction(cursor.value);
                if(cmp === true) {
                    if(offset > 0) {
                        offset -= 1;
                    } else {
                        answer += 1;
                        limit -= 1;
                    }
                }
                cursor.continue();
            }
        };
        await Database._transactionPromise(tx);
        console.log(`Brief: done count query in ${totalCallbacks} callbacks`, filters);
        return answer;
    },

    _filters() {
        let filters = {};

        // First let's combine all feed-only filters
        let {
            feeds,
            folders,
            includeHiddenFeeds,
            includeFeedsExcludedFromGlobalViews,
        } = this;
        let active_feeds = Database.feeds;
        // Folder list
        if(folders !== undefined) {
            let childrenMap = new Map();
            for(let node of Database.feeds) {
                let parent = node.parent;
                let children = childrenMap.get(parent) || [];
                children.push(node.feedID);
                childrenMap.set(parent, children);
            }
            console.log(childrenMap);
            let nodes = [];
            let new_nodes = folders;
            while(new_nodes.length > 0) {
                let node = new_nodes.pop();
                nodes.push(node);
                let children = childrenMap.get(node) || [];
                new_nodes.push(...children);
            }
            active_feeds = active_feeds.filter(feed => nodes.includes(feed.feedID));
        }
        // Feed list
        if(feeds !== undefined) {
            active_feeds = active_feeds.filter(feed => feeds.includes(feed.feedID));
            includeHiddenFeeds = true; //FIXME: query magic
        }
        // Include hidden feeds
        if(!includeHiddenFeeds) {
            active_feeds = active_feeds.filter(feed => !feed.hidden);
        }
        // Include hidden feeds
        if(!includeFeedsExcludedFromGlobalViews) {
            active_feeds = active_feeds.filter(feed => !feed.omitInUnread);
        }
        // Feeds done
        filters.feeds = active_feeds.map(feed => feed.feedID);

        // Entry-based filters
        filters.entry = {
            read: +this.read,
            starred: this.starred,
            deleted: +this.deleted,
            tags: this.tags,
        };
        filters.fullTextSearch = this.searchString;

        // Sorting and limiting...
        if(this.sortOrder !== undefined && this.sortOrder !== 'date') {
            throw `Invalid sort order: ${this.sortOrder}`
        }
        filters.sort = {
            direction: this.sortDirection,
            limit: this.limit,
            offset: this.offset,
            start: this.startDate,
            end: this.endDate,
        };

        return filters;
    },
    _searchEngine(filters) {
        // And now
        let indexName = 'deleted_read_feedID_date'; // FIXME: hardcoded
        if(filters.sort.direction !== 'desc')
            throw "asc not supported yet"; //FIXME

        let filterFunction = entry => {
            return (true
                && (!filters.feeds || filters.feeds.includes(entry.feedID))
                && (filters.entry.read === undefined || filters.entry.read === entry.read)
                && (filters.entry.starred === undefined || filters.entry.starred === entry.starred)
                && (filters.entry.deleted === undefined || filters.entry.deleted === entry.deleted)
                && (filters.entry.tags === undefined || filters.entry.tags.some(tag => entry.tags.includes(tag)))
                // FIXME: no FTS support at all, even slow one
                && (filters.sort.start === undefined || entry.date >= filters.sort.start)
                && (filters.sort.end === undefined || entry.date <= filters.sort.end)
            );
        };

        let ranges = [undefined];

        return {indexName, filterFunction, ranges};
    },
};