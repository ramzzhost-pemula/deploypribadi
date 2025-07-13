
const express = require("express");
const path = require("path");
const axios = require("axios");
const unzipper = require("unzipper");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const port = process.env.PORT || 3000;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Define a route for the homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Deploy to Vercel endpoint
app.post("/api/deploy", upload.single("zipfile"), async (req, res) => {
  try {
    const { token, projectName } = req.body;
    const defaultToken = "hM4mbeUYkF1O51xZSfV6Vluj";

    if (!req.file) {
      return res.status(400).json({ error: "File ZIP tidak ditemukan" });
    }

    if (!projectName) {
      return res.status(400).json({ error: "Nama project tidak valid" });
    }

    const useToken = token || defaultToken;
    const buffer = req.file.buffer;

    // Process ZIP file
    const zipEntries = await unzipper.Open.buffer(buffer);
    const filesMeta = [];
    const filesContent = {};

    const folderNames = new Set();
    for (const entry of zipEntries.files) {
      if (entry.path.includes("/")) {
        const rootFolder = entry.path.split("/")[0];
        folderNames.add(rootFolder);
      }
    }
    const mainFolder = folderNames.size === 1 ? Array.from(folderNames)[0] : null;

    for (const entry of zipEntries.files) {
      if (entry.type !== "File") continue;

      const content = await entry.buffer();
      const sha = crypto.createHash("sha1").update(content).digest("hex");

      let cleanPath = entry.path.replace(/^\/+/, "").replace(/\\/g, "/");
      if (mainFolder && cleanPath.startsWith(mainFolder + "/")) {
        cleanPath = cleanPath.replace(mainFolder + "/", "");
      }

      filesMeta.push({
        file: cleanPath,
        sha,
        size: content.length
      });

      filesContent[sha] = content;
    }

    if (!filesMeta.length) {
      return res.status(400).json({ error: "ZIP kosong atau gagal dibaca" });
    }

    // Upload files to Vercel
    for (const file of filesMeta) {
      const check = await axios.get(`https://api.vercel.com/v2/files/${file.sha}`, {
        headers: { Authorization: `Bearer ${useToken}` }
      }).catch(() => null);

      if (!check || check.status === 404) {
        await axios.post(`https://api.vercel.com/v2/files`, filesContent[file.sha], {
          headers: {
            Authorization: `Bearer ${useToken}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": file.size,
            "x-vercel-digest": file.sha
          }
        });
      }
    }

    // Create deployment
    const deployRes = await axios.post("https://api.vercel.com/v13/deployments", {
      name: projectName,
      files: filesMeta,
      target: "production",
      projectSettings: {
        framework: null,
        devCommand: null,
        installCommand: null,
        buildCommand: null,
        outputDirectory: null,
        rootDirectory: null
      }
    }, {
      headers: {
        Authorization: `Bearer ${useToken}`,
        "Content-Type": "application/json"
      }
    });

    const deploymentId = deployRes.data.id;

    // Wait for deployment to be ready
    let ready = false;
    let attempts = 0;
    while (!ready && attempts < 10) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const status = await axios.get(`https://api.vercel.com/v13/deployments/${deploymentId}`, {
        headers: { Authorization: `Bearer ${useToken}` }
      });
      if (status.data.readyState === "READY") {
        ready = true;
      }
      attempts++;
    }

    if (!ready) {
      return res.status(500).json({ error: "Deployment belum READY setelah beberapa percobaan" });
    }

    // Set alias
    await axios.post(`https://api.vercel.com/v2/deployments/${deploymentId}/aliases`, {
      alias: `${projectName}.vercel.app`
    }, {
      headers: {
        Authorization: `Bearer ${useToken}`,
        "Content-Type": "application/json"
      }
    });

    res.json({
      success: true,
      project: projectName,
      url: `https://${projectName}.vercel.app`
    });

  } catch (error) {
    console.error("Deploy error:", error);
    const errorMsg = error?.response?.data || error.message;
    res.status(500).json({
      error: typeof errorMsg === "string" ? errorMsg : JSON.stringify(errorMsg, null, 2)
    });
  }
});

// List Deployments endpoint
app.get("/api/listdeploy", async (req, res) => {
  console.log("[/api/listdeploy] Request received");
  try {
    const token = req.query.token || "hM4mbeUYkF1O51xZSfV6Vluj";
    console.log("[/api/listdeploy] Using token:", token);

    const response = await axios.get("https://api.vercel.com/v6/deployments", {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    console.log("[/api/listdeploy] Vercel API response status:", response.status);

    const deployments = response.data.deployments;

    if (!deployments || deployments.length === 0) {
      console.log("[/api/listdeploy] No deployments found.");
      return res.json({ message: "Anda belum punya deployment di Vercel." });
    }

    console.log("[/api/listdeploy] Deployments found:", deployments.length);
    res.json({ success: true, deployments });

  } catch (error) {
    console.error("[/api/listdeploy] Listdeploy error:", error.response?.data || error.message);
    const errorMsg = error?.response?.data || error.message;
    res.status(500).json({
      error: typeof errorMsg === "string" ? errorMsg : JSON.stringify(errorMsg, null, 2)
    });
  }
});

// Delete Deployment endpoint
app.delete("/api/deldeploy", async (req, res) => {
  try {
    const { token, deploymentId } = req.body;
    const defaultToken = "hM4mbeUYkF1O51xZSfV6Vluj";

    const useToken = token || defaultToken;

    if (!deploymentId) {
      return res.status(400).json({ error: "Deployment ID tidak valid." });
    }

    const response = await axios.delete(`https://api.vercel.com/v13/deployments/${deploymentId}`, {
      headers: {
        Authorization: `Bearer ${useToken}`
      }
    });

    if (response.status === 200) {
      res.json({ success: true, message: `Berhasil menghapus deployment! ID: ${deploymentId}` });
    } else {
      res.status(response.status).json({ error: `Gagal menghapus deployment. Status: ${response.status}` });
    }

  } catch (error) {
    console.error("Deldeploy error:", error);
    const errorMsg = error?.response?.data || error.message;
    res.status(500).json({
      error: typeof errorMsg === "string" ? errorMsg : JSON.stringify(errorMsg, null, 2)
    });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server is running on http://localhost:${port}`);
});


