const mysql = require('mysql2');

function createDbConnection(env) {
  return mysql.createConnection({
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
    timezone: '+00:00',
  });
}

function connectDb(db) {
  db.connect(error => {
    if (error) {
      throw error;
    }

    console.log('MySQL database connected');
    db.query("SET time_zone = '+00:00'", err => {
      if (err) {
        console.error('Failed to set time_zone to +00:00:', err);
      } else {
        console.log('MySQL session time_zone set to +00:00 (UTC)');
      }
    });
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
