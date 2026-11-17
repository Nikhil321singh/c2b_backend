import express from 'express'
import bonusSlabController from '../controller/bonusSlabController.js'
import verifyToken from '../middlewares/authJwt.js'
import { checkRole, ROLES } from '../middlewares/rbac.js'

const bonusSlabRoute = express.Router()

bonusSlabRoute
  .post(
    '/config',
    verifyToken,
    checkRole([ROLES.SUPER_ADMIN]),
    bonusSlabController.createOrUpdate
  )
  .get(
    '/config/:companyId',
    verifyToken,
    checkRole([ROLES.SUPER_ADMIN]),
    bonusSlabController.getByCompanyId
  )
  .get(
    '/all',
    verifyToken,
    checkRole([ROLES.SUPER_ADMIN]),
    bonusSlabController.getAll
  )
  .delete(
    '/config/:companyId',
    verifyToken,
    checkRole([ROLES.SUPER_ADMIN]),
    bonusSlabController.remove
  )
  .post(
    '/calculate-bonus',
    verifyToken,
    bonusSlabController.calculateBonus
  )
  .get(
    '/status/:companyId',
    verifyToken,
    bonusSlabController.getConfigStatus
  )
  .post(
    '/bulk-toggle',
    verifyToken,
    checkRole([ROLES.SUPER_ADMIN]),
    bonusSlabController.bulkToggle
  )
  .get(
    '/export',
    verifyToken,
    checkRole([ROLES.SUPER_ADMIN]),
    bonusSlabController.exportConfig
  )

export default bonusSlabRoute
