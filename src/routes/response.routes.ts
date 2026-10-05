import { Router } from "express";
import {
  getResponses,
  getResponseStats,
  getResponseDetail,
  updateResponseStatus,
  deleteResponse,
  getResponseFileUrl,
  markResponseRead,
  markResponseUnread,
  getResponseActivity,
  clearEditedAfterReview,
} from "../controllers/response.controller";
import { bulkUpdateResponses } from "../controllers/bulk.controller";
import { listNotes, createNote, updateNote, deleteNote } from "../controllers/note.controller";
import { scoreResponse, getResponseScore } from "../controllers/score.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

const router = Router();

// Scope all response routes with authentication and suspension checks
router.get("/", protect as any, blockSuspended as any, requirePermission("responses:read") as any, getResponses);
router.get("/stats", protect as any, blockSuspended as any, requirePermission("responses:read") as any, getResponseStats);
// Mounted before "/:id" so "bulk" is never swallowed as an :id.
router.post("/bulk", protect as any, blockSuspended as any, requirePermission("responses:read") as any, bulkUpdateResponses);
router.get("/:id", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, getResponseDetail);
router.patch("/:id", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "response" }) as any, updateResponseStatus);
router.put("/:id", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "response" }) as any, updateResponseStatus);
// Sprint 13 (A5.2): "Mark as reviewed" clears the Edited-after-review flag.
router.patch("/:id/edited-after-review", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "response" }) as any, clearEditedAfterReview);
router.delete("/:id", protect as any, blockSuspended as any, requirePermission("responses:delete", { resourceType: "response" }) as any, deleteResponse);
router.post("/:id/read", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, markResponseRead);
router.post("/:id/unread", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, markResponseUnread);
router.get("/:id/file/:fileId", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, getResponseFileUrl);

// Notes (B5.1/B5.2/B5.3). List/create need the "act" tier this repo implements as responses:write;
// edit/delete are further gated inside note.service.ts (author-only edit; author-or-Admin+ delete).
router.get("/:id/notes", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, listNotes);
router.post("/:id/notes", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "response" }) as any, createNote);
router.patch("/:id/notes/:noteId", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "response" }) as any, updateNote);
router.delete("/:id/notes/:noteId", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, deleteNote);

router.get("/:id/activity", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, getResponseActivity);

// Scoring (Sprint 12, BE 0.5 / B6.1, OQ-7 resolved 3 Oct 2026). Scoring a response requires the
// "act" tier this repo implements as responses:write, same as notes create/update.
router.put("/:id/score", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "response" }) as any, scoreResponse);
router.get("/:id/score", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, getResponseScore);

export default router;
