const { handleChats } = require("../lib/accounts");

module.exports = (req, res) => handleChats(req, res);
