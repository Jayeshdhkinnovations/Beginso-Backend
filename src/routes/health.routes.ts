import { Router } from "express";
import { buildInfo } from "../utils/buildInfo";

const router = Router();

router.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Backend is running successfully",
        // Sprint 14 (BE 0.12): the same build info `GET /` reports, so a deploy can be verified from the health check.
        ...buildInfo
    });
});

export default router;
