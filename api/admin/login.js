const { handleLogin } = require("../../lib/admin");
const { sendJson } = require("../../lib/handlers");

module.exports = (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  return handleLogin(req, res);
};
