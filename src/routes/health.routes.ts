import { Router } from "express";
import { buildInfo, publicBuildInfo } from "../utils/buildInfo";

const router = Router();

router.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Backend is running successfully",
        // Sprint 14 (BE 0.12): the commit id, so a deploy can be verified from the health check. Only the id: the commit
        // message and deploy time are not public (see publicBuildInfo).
        ...publicBuildInfo(buildInfo)
    });
});

export default router;
