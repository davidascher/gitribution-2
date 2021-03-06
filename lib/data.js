var mysql = require('mysql');
var async = require('async');
var util = require("./util");
var dates = require("./dates");
var NodeCache = require("node-cache");

var myCache = new NodeCache();

var connectionOptions = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
};

if (process.env.DB_SSL) {
  // SSL is used for Amazon RDS, but not necessarily for local dev
  connectionOptions.ssl = process.env.DB_SSL;
}

/**
 * Save a single contribution item
 */
function saveItem(happenedOn, githubOrgName, githubRepo, githubLogin, githubPublicEmail, htmlUrl, actionType, commitID, commitMsg, callback) {

  var connection = mysql.createConnection(connectionOptions);
  connection.connect(function connectionAttempted(err) {
    if (err) {
      console.error(err);
      callback(err);
    } else {

      var activity = {
        happened_on: new Date(happenedOn),
        github_organization: githubOrgName,
        github_repository: githubRepo,
        github_username: githubLogin,
        github_public_email: githubPublicEmail,
        github_commit_url: htmlUrl,
        action_type: actionType,
        commit_id: commitID,
        commit_msg: commitMsg
      };

      // Using REPLACE INTO to avoid worrying about duplicate entries for activities
      // There is a unique key set across all the fields
      connection.query('REPLACE INTO activities SET ? ON DUPLICATE KEY UPDATE commit_id=commit_id', activity, function (err, result) {
        if (err) {
          console.error(err);
          callback(err);
        }
        connection.end();
        callback(null);
      });
    }
  });
}

/**
 * Save multiple contribution item
 * 'items' is an array of arrays
 * each nester array matches the activities columns listed in the SQL below
 * This is turned into a nested array:
 * https://github.com/felixge/node-mysql#escaping-query-values
 */
function saveItems(items, callback) {

  var connection = mysql.createConnection(connectionOptions);
  connection.connect(function connectionAttempted(err) {
    if (err) {
      console.error(err);
      callback(err);
    } else {

      var sql = 'INSERT INTO activities (happened_on, github_organization, github_repository, github_username, github_public_email, github_commit_url, action_type, commit_id, commit_msg) VALUES ? ON DUPLICATE KEY UPDATE commit_id=commit_id';
      var values = items;

      // Using REPLACE INTO to avoid worrying about duplicate entries for activities
      // There is a unique key set across all the fields
      connection.query(sql, [values], function (err, result) {
        if (err) {
          console.error(err);
          callback(err);
        }
        connection.end();
        callback(null);
      });
    }
  });
}

function getOldestOrNewestActivityDate(repo, oldestOrNewest, actionType, callback) {
  var connection = mysql.createConnection(connectionOptions);
  connection.connect(function connectionAttempted(err) {
    if (err) {
      console.error(err);
      callback(err);
    } else {

      var sql;
      // vary the sort order - choosing duplication over string concatenation for clarity here.
      if (oldestOrNewest === 'oldest') {
        sql = 'SELECT * FROM activities WHERE github_organization=? AND github_repository=? AND action_type=? ORDER BY happened_on asc limit 1;';
      } else {
        sql = 'SELECT * FROM activities WHERE github_organization=? AND github_repository=? AND action_type=? ORDER BY happened_on desc limit 1;';
      }
      var values = [repo.org, repo.name, actionType];
      var qry = connection.query(sql, values, function (err, result) {
        if (err) {
          console.error(err);
          console.log(qry.sql);
          callback(err);
        }
        connection.end();

        // check if this repo has any commits (it might be new)
        var date = null;
        if (result[0] && result[0].happened_on) {
          date = result[0].happened_on;
        }
        callback(null, date);
      });
    }
  });
}

/**
 * Get the date of the oldest commit we have in our DB
 */
function getOldestCommitDate(repo, callback) {
  getOldestOrNewestActivityDate(repo, 'oldest', 'commit-author', function (err, res) {
    callback(null, res);
  });
}

/**
 * Get the date of the most recent commit we have in our DB
 */
function getLatestCommitDate(repo, callback) {
  getOldestOrNewestActivityDate(repo, 'newest', 'commit-author', function (err, res) {
    callback(null, res);
  });
}

/**
 * Get the date of the oldest PR we have in our DB
 */
function getOldestPullRequestDate(repo, callback) {
  getOldestOrNewestActivityDate(repo, 'oldest', 'pull-request-opened', function (err, res) {
    callback(null, res);
  });
}

/**
 * Get the date of the most recent PR we have in our DB
 */
function getLatestPullRequestDate(repo, callback) {
  getOldestOrNewestActivityDate(repo, 'newest', 'pull-request-opened', function (err, res) {
    callback(null, res);
  });
}

/**
 * Get the date of the oldest issue we have in our DB
 */
function getOldestIssueDate(repo, callback) {
  getOldestOrNewestActivityDate(repo, 'oldest', 'issue-opened', function (err, res) {
    callback(null, res);
  });
}

/**
 * Get the date of the most recent issue we have in our DB
 */
function getLatestIssueDate(repo, callback) {
  getOldestOrNewestActivityDate(repo, 'newest', 'issue-opened', function (err, res) {
    callback(null, res);
  });
}

/**
 * Get total active count for a given date
 * @param  {Date}   date
 * @param  {Function} callback
 */
function countActiveContributors(date, team, callback) {
  console.log('countActiveContributors', date, team);
  var connection = mysql.createConnection(connectionOptions);
  connection.connect(function connectionAttempted(err) {
    if (err) {
      console.error(err);
      callback(err);
    } else {

      var queryDate = new Date(date);
      queryDate.setHours(0, 0, 0, 0);

      var weekPrior = new Date(queryDate);
      weekPrior.setDate(queryDate.getDate() - 7);

      var yearPrior = new Date(queryDate);
      yearPrior.setFullYear(yearPrior.getFullYear() - 1);

      // format these for query
      queryDate = util.dateToISOtring(queryDate);
      weekPrior = util.dateToISOtring(weekPrior);
      yearPrior = util.dateToISOtring(yearPrior);

      /*jshint multistr: true */
      var sql = 'SELECT DISTINCT github_username FROM activities \
                WHERE happened_on <= ? AND happened_on > ? ;';

      if (team) {
        var teamRepos = util.reposForTeam(team);
        /*jshint multistr: true */
        sql = 'SELECT DISTINCT github_username FROM activities \
                WHERE happened_on <= ? AND happened_on > ? \
                AND CONCAT(github_organization, \'/\', github_repository) IN (?);';
      }

      async.parallel({
          last_year: function (callback) {
            var values = [queryDate, yearPrior];
            if (team) {
              values.push(teamRepos);
            }
            connection.query(sql, values,
              function queryComplete(err, result) {
                if (err) {
                  console.log(err);
                }
                callback(null, result);
              });
          },
          last_week: function (callback) {
            var values = [queryDate, weekPrior];
            if (team) {
              values.push(teamRepos);
            }
            connection.query(sql, values,
              function queryComplete(err, result) {
                if (err) {
                  console.log(err);
                }
                callback(null, result);
              });
          },
          last_year_excluding_last_week: function (callback) {
            var values = [weekPrior, yearPrior];
            if (team) {
              values.push(teamRepos);
            }
            connection.query(sql, values,
              function queryComplete(err, result) {
                if (err) {
                  console.log(err);
                }
                callback(null, result);
              }
            );
          }
        },
        function (err, results) {
          var namesYear = util.fieldToArray(results.last_year, "github_username");
          var namesWeek = util.fieldToArray(results.last_week, "github_username");
          var namesYearExWeek = util.fieldToArray(results.last_year_excluding_last_week, "github_username");

          var counts = {};
          counts.wkcommencing = queryDate;
          counts.totalactive = namesYear.length;
          counts.new = util.countInAnotInB(namesWeek, namesYearExWeek);

          connection.end();
          callback(null, counts);
        });
    }
  });
}

function getSummariesFor(team, callback) {
  var connection = mysql.createConnection(connectionOptions);
  connection.connect(function connectionAttempted(err) {
    if (err) {
      console.error(err);
      callback(err);
    } else {

      var sql = 'SELECT * FROM summary WHERE team=? AND type="graph" ORDER BY wkcommencing;';
      var values = [team];
      var qry = connection.query(sql, values, function (err, result) {
        if (err) {
          console.error(err);
          console.log(qry.sql);
          callback(err);
        }
        connection.end();
        callback(null, result);
      });
    }
  });
}

/**
 * Get counts by week of rolling total active for all teams combined
 * @param  {Function} callback
 */
function get2014TotalActive(team, callback) {
  console.log('get2014TotalActive');
  if (team === null) {
    team = 'all';
  }
  var cacheName = team + 'totals';

  // timer to check impact of loading
  console.time('getData');

  // check cache
  var cache = myCache.get(cacheName);

  // check if anythign is saved in the cache
  if (cache[cacheName]) {
    // Yes, use the cached list
    console.log('loaded from cache');
    console.timeEnd('getData');
    callback(null, cache[cacheName]);

  } else {
    // No cache, so need to get this from the DB
    console.log('loading from database');

    getSummariesFor(team, function gotSummaries(err, result) {
      var totals2014 = util.formatSummaryResults(result);
      console.timeEnd('getData');
      myCache.set(cacheName, totals2014, 600000); // 10 mins
      callback(null, totals2014);
    });
  }
}

/**
 * Save into summary table
 * @param  {String}   team
 * @param  {String}   type
 * @param  {Date}   wkcommencing
 * @param  {Int}   totalactive
 * @param  {Int}   newactive
 * @param  {Function} callback
 */
function saveSummary(team, type, qryres, callback) {
  console.log('saveSummary');

  var connection = mysql.createConnection(connectionOptions);
  connection.connect(function connectionAttempted(err) {
    if (err) {
      console.error(err);
      callback(err);
    } else {

      if (team === null) {
        team = 'all';
      }

      var summary = {
        team: team,
        type: type,
        wkcommencing: qryres.wkcommencing,
        totalactive: qryres.totalactive,
        new: qryres.new
      };

      // Using REPLACE INTO to avoid worrying about duplicate entries for activities
      // There is a unique key set across all the fields
      connection.query('REPLACE INTO summary SET ?', summary, function (err, result) {
        if (err) {
          console.error(err);
          callback(err);
        }
        connection.end();
        callback(null);
      });
    }
  });
}

/**
 * Get counts by week of rolling total active for all teams combined
 * @param {String} team - teamname, or null to get ALL combined
 * @param  {Function} callback
 */
function summarize2014TotalActive(team, callback) {
  console.log('summarize2014TotalActive');
  // timer to check impact of loading
  console.time('getData');

  async.eachSeries(dates.year2014toDate(),
    function eachDo(date, callback) {
      console.log('eachDo');
      countActiveContributors(date, team, function gotActive(err, res) {
        if (err) {
          console.log(err);
          callback(null);

        } else {
          saveSummary(team, 'graph', res, function savedSummary(err) {
            callback(null);
          });
        }
      });
    },
    function eachDone(err) {
      if (err) {
        console.log(err);
      }
      console.timeEnd('getData');
      if (team === null) {
        team = 'ALL';
      }
      console.log('Saved summaries for:', team);
      callback(null);
    });
}

/**
 * Get the date of the most recent commit we have in our DB
 */
function getAllRepos(callback) {
  var connection = mysql.createConnection(connectionOptions);
  connection.connect(function connectionAttempted(err) {
    if (err) {
      console.error(err);
      callback(err);
    } else {

      var sql = 'SELECT DISTINCT CONCAT(github_organization, \'/\', github_repository) as repo FROM activities;';
      var qry = connection.query(sql, function (err, result) {
        if (err) {
          console.error(err);
          console.log(qry.sql);
          callback(err);
        }
        connection.end();
        var output = util.fieldToArray(result, 'repo');
        callback(null, output);
      });
    }
  });
}

/**
 * Get the date of the most recent commit we have in our DB
 */
function getEmailFromLogin(login, callback) {
  var connection = mysql.createConnection(connectionOptions);
  connection.connect(function connectionAttempted(err) {
    if (err) {
      console.error(err);
      callback(err);
    } else {

      var sql = 'SELECT github_public_email from activities WHERE github_username = ? LIMIT 1;';
      var values = [login];
      var qry = connection.query(sql, values, function (err, result) {
        if (err) {
          console.error(err);
          console.log(qry.sql);
          callback(err);
        }
        connection.end();
        var email = null;
        if (result && result[0] && result[0]['github_public_email']) {
          email = result[0].github_public_email;
        }

        callback(null, email);
      });
    }
  });
}

module.exports = {
  countActiveContributors: countActiveContributors,
  get2014TotalActive: get2014TotalActive,
  summarize2014TotalActive: summarize2014TotalActive,
  getOldestCommitDate: getOldestCommitDate,
  getLatestCommitDate: getLatestCommitDate,
  getOldestPullRequestDate: getOldestPullRequestDate,
  getLatestPullRequestDate: getLatestPullRequestDate,
  saveItem: saveItem,
  saveItems: saveItems,
  getAllRepos: getAllRepos,
  saveSummary: saveSummary,
  getEmailFromLogin: getEmailFromLogin,
  getOldestIssueDate: getOldestIssueDate,
  getLatestIssueDate: getLatestIssueDate,
};
