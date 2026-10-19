const { handleAuth } = require("../lib/accounts");

module.exports = (req, res) => handleAuth(req, res);
