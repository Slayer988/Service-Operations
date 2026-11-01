'use strict';
// The User Manual: opened from the "?" icon in a new tab. Anyone signed in may read it; each person sees the sections that apply to their role.
const express = require('express');
const manual = require('../lib/manual');
const perms = require('../lib/perms');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/manual', requireLogin, (req, res) => {
  const sections = manual.forUser(req.user);
  res.render('manual', { title: 'User Manual', sections, inline: manual.inline, myRole: perms.ROLE_LABELS[req.user.role] || '', customer: req.user.kind === 'customer' });
});

module.exports = router;
