'use strict';
// 管理者ルート集約（各機能は admin-*.js に分割）

const express = require('express');
const router = express.Router();

router.use('/', require('./admin-auth'));
router.use('/', require('./admin-staff'));
router.use('/', require('./admin-incentive'));
router.use('/', require('./admin-billing'));
router.use('/', require('./admin-record'));
router.use('/', require('./admin-standby'));
router.use('/', require('./admin-audit'));
router.use('/', require('./admin-attendance'));
router.use('/', require('./admin-excel'));
router.use('/', require('./admin-sheets'));

module.exports = router;
