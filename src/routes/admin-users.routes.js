const { Router } = require('express');
const {
  getAdminUserManagementSnapshot,
  updateAdminSecuritySettings,
} = require('../services/adminUsers');

const router = Router();

// GET /api/admin/users — administrator directory, audit, role, and security snapshot
router.get('/', async (req, res, next) => {
  try {
    const data = await getAdminUserManagementSnapshot();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/users/security — persist admin security controls
router.put('/security', async (req, res, next) => {
  try {
    const data = await updateAdminSecuritySettings(undefined, req.body || {}, req.adminActor);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
