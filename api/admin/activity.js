const { handleActivity } = require("../../lib/admin");
const { sendJson } = require("../../lib/handlers");

module.exports = (req, res) => {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  return handleActivity(req, res);
};
