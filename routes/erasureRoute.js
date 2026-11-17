import express from "express";
import erasureController from "../controller/erasureController.js";
import verifyToken from "../middlewares/authJwt.js";
import { checkRole } from "../middlewares/rbac.js";

const erasureRoute = express.Router();

// DPDP Act 2023 - Section 5.2: Right to Erasure
// All routes require authentication

// Request data erasure (user can request for self, admin can request for any user)
erasureRoute.post("/request", verifyToken, erasureController.requestErasure);

// Cancel pending erasure request
erasureRoute.post("/cancel/:requestId", verifyToken, erasureController.cancelErasure);

// Get erasure status for a user
erasureRoute.get("/status/:userId", verifyToken, erasureController.getErasureStatus);

// List all pending requests (Admin only)
erasureRoute.get(
  "/pending",
  verifyToken,
  checkRole(["Super Admin", "Admin Manager"]),
  erasureController.getPendingRequests
);

// Manually execute erasure (Admin only, after grace period)
erasureRoute.post(
  "/execute/:requestId",
  verifyToken,
  checkRole(["Super Admin"]),
  erasureController.executeErasure
);

export default erasureRoute;
