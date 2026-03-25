const mysql = require('mysql');

function createDbConnection(env) {
  return mysql.createConnection({
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
  });
}

function connectDb(db) {
  db.connect(error => {
    if (error) {
      throw error;
    }

    console.log('MySQL database connected');
  });
}

function createQueryDb(db) {
  return function queryDb(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.query(sql, params, (error, results) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(results);
      });
    });
  };
}

module.exports = {
  createDbConnection,
  connectDb,
  createQueryDb,
};
