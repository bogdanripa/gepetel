import express from "express";
const router = express.Router();

router.get("/", async function (req, res, next) {
    const ipLocation = await fetch("http://ip-api.com/json/")
        .then((res) => res.json())
        .catch(() => ({ status: "fail" }));

    if (ipLocation.status === "fail") {
        return `Hello! Failed to get the server location :(`;
    }

    const formattedTime = new Date().toLocaleString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
    });

    res.send({
        message: `Hello! This response was served from ${ipLocation.city}, ${ipLocation.country} (${ipLocation.lat}, ${ipLocation.lon}) at ${formattedTime}`,
    });
});

router.get("/:name", async function (req, res, next) {
    const ipLocation = await fetch("http://ip-api.com/json/")
        .then((res) => res.json())
        .catch(() => ({ status: "fail" }));

    if (ipLocation.status === "fail") {
        return `Hello! Failed to get the server location :(`;
    }

    const formattedTime = new Date().toLocaleString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
    });

    res.send({
        message: `Hello ${req.params.name}! This response was served from ${ipLocation.city}, ${ipLocation.country} (${ipLocation.lat}, ${ipLocation.lon}) at ${formattedTime}`,
    });
});

export default router;
