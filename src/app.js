import express from "express";
import path from "path";
import cookieParser from "cookie-parser";
import logger from "morgan";
import { dirname } from "dirname-filename-esm";

import helloRouter from "./routers/hello.js";

// app
const app = express();

// plugins
app.use(logger(process.env.NODE_ENV === "production" ? "common" : "dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(dirname(import.meta), "../", "public")));

// routers
app.use("/hello", helloRouter);

app.listen(8080, () => {
    console.log("Server is running on port 8080. Check the app on http://localhost:8080");
});
