import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

process.env.DB_USER_NAME = 'u';
process.env.DB_PASSWORD = 'p';
process.env.DB_NAME = 'testdb';

let usedUri = null;

const mongodbMock = test.mock.module('mongodb', {
  namedExports: {
    MongoClient: class {
      constructor(uri) {
        usedUri = uri;
      }
      async connect() {
        this.connected = true;
      }
      db(name) {
        return { name };
      }
    }
  }
});

const { connectDB } = await import('../db.js');

mongodbMock.restore();

test('connectDB connects using MongoClient and returns db instance', async () => {
  const db = await connectDB();
  assert.ok(db);
  assert.equal(db.name, 'testdb');
  assert.ok(usedUri.includes('u')); // uri contains username
});
