import fs from "fs";
import esMain from "es-main";
import express from "express";
import morgan from "morgan";
import axios from "axios";
import AdmZip from "adm-zip";
import chalk from "chalk";

import config from "./config.js";

const ugoiraConvertQueue = [];
const ugoiraMetaRequest = axios.create({
  baseURL: "https://www.pixiv.net/ajax/",
  validateStatus: status => status < 500,
  headers: {
    "User-Agent": config.pixiv.ua,
    Cookie: config.pixiv.cookie,
  },
});

// Decide use native FFmpeg or FFmpeg.wasm
let ffmpegInstance,
  ffmpegLoadingPromise,
  useNativeFfmpeg = false,
  ffPath = config.ffmpeg.path;
if (ffPath && (fs.existsSync(ffPath) || ffPath.toLowerCase() == "ffmpeg.exe")) {
  console.info("Use Native FFmpeg.");
  ffmpegLoadingPromise = new Promise(resolve =>
    import("./utils/ffmpeg.js").then(({ ffmpeg }) => {
      ffmpegInstance = ffmpeg;
      useNativeFfmpeg = true;
      resolve();
    })
  );
} else {
  console.info("Use FFmpeg.wasm.");
  ffmpegLoadingPromise = new Promise(resolve =>
    import("@ffmpeg/ffmpeg").then(({ createFFmpeg }) => {
      ffmpegInstance = createFFmpeg({ log: true });
      resolve(ffmpegInstance.load());
    })
  );
}
async function initFFmpeg() {
  if (ffmpegLoadingPromise) {
    await ffmpegLoadingPromise;
    ffmpegLoadingPromise = undefined;
  }
  return ffmpegInstance;
}

let args = process.argv.slice(2),
  isCliMode = esMain(import.meta);
if (!isCliMode || args.length === 0) {
  console.log(
    chalk.bgGreen(
      "You can execute me with Pixiv ugoira post number ID as arguments or leave blank running as a backend service.\n" +
        "Multiple posts can be separated by English comma or space."
    )
  );
  isCliMode = false;
} else {
  args = args
    .join(" ")
    .split(/,|\s/)
    .filter(arg => !!arg);
  if (args.every(arg => /^\d+$/.test(arg))) {
    for (let arg of args) {
      console.log(chalk.bgYellow(`Processing ${arg}....`));
      await ugoira2mp4(arg);
    }
  } else {
    console.log(
      chalk.bgRed(
        "Invalid arguments.\nPlease only input numbers sparated by English comma or space only."
      )
    );
  }
  process.exit(0);
}

const app = express();
app.use(morgan("dev"));
const port = process.env.PORT || config.port;

app.get("/", async (req, res) => {
  res.status(200).send("Hello World!");
});

/* app.get("/favicon.ico", (req, res) => { return res.status(404).end(); }); */

app.get(/\/ugoira2mp4\/\d+\.mp4/, async (req, res) => {
  let id = req.path.split(/\/|\./)?.[2];
  id = Number(id).toString();
  let cached = optCache();
  let filename = cached[id];
  if (filename) {
    res.setHeader("content-type", "video/mp4");
    res.send(fs.readFileSync(`./src/${filename}`));
    return;
  }
  let opt = await ugoira2mp4(id);
  if (opt) {
    cached = optCache();
    res.setHeader("content-type", "video/mp4");
    res.send(fs.readFileSync(`./src/${cached[id]}`));
    return;
  }
  res
    .status(500)
    .send(
      "<!DOCTYPE html><head></head><body><pre><html></html>Convert Failure.\n\nReason:\n1. Requested artwork ID is not a ugoira or not existed.\n2. Target file is too large.\n3. Invalid or expired cookie.</pre></body></html>"
    );
});

function optCache() {
  if (!fs.existsSync("./src/")) fs.mkdirSync("./src/");
  let files = fs.readdirSync("./src/");
  if (files.length > 4) {
    files.splice(0, 1);
    fs.rmSync(`./src/${files[0]}`, { force: true });
  }
  let cachedFiles = {};
  files.forEach(filename => {
    cachedFiles[filename.slice(14, -4)] = filename;
  });
  return cachedFiles;
}

async function getUgoiraData(url, tmpPath) {
  // url = url.replace("https://i.pximg.net/", "https://i-cf.pximg.net/");
  try {
    let data = (
      await axios({
        url: url,
        method: "GET",
        responseType: "arraybuffer",
        headers: {
          "User-Agent": config.pixiv.ua,
          Referer: "https://www.pixiv.net/",
        },
      })
    ).data;
    let zip = new AdmZip(data);
    let framesData = [];
    if (useNativeFfmpeg) {
      zip.extractAllTo(tmpPath, true);
    } else zip.forEach(zipEntry => framesData.push(zipEntry.getData()));
    data = undefined;
    zip = undefined;
    return framesData;
  } catch (e) {
    console.log(e);
    return;
  }
}

async function ugoira2mp4(id, retryTimes = 0) {
  if (retryTimes > 3) {
    console.log(chalk.bgRed("Retry times exceed 3."));
    return;
  }
  if (ugoiraConvertQueue.length > 4 || ugoiraConvertQueue.indexOf(id) > -1) {
    await sleep(1000);
    return await ugoira2mp4(id, retryTimes);
  }
  ugoiraConvertQueue.push(id);
  try {
    fs.mkdirSync(`./tmp/${id}/`, { recursive: true });
  } catch (e) {
    e.code === "EEXIST" && console.log(`Path ${e.path} already exists.`);
  }

  let opt;
  try {
    const meta = (await ugoiraMetaRequest(`/illust/${id}/ugoira_meta`))?.data;
    if (meta && !meta.error) {
      const { originalSrc, frames } = meta.body;
      const framesData = await getUgoiraData(originalSrc, `./tmp/${id}/`);
      if (framesData) {
        opt = await frames2mp4(frames, framesData, id);
      }
    }
  } catch (e) {
    console.log(e);
    removeConvertCache(id);
    await sleep(2000);
    return await ugoira2mp4(id, retryTimes + 1);
  }
  removeConvertCache(id);
  return opt;
}

async function frames2mp4(frames, framesData, id = "1") {
  const ffmpeg = await initFFmpeg();
  const len = frames.length;
  let argsOfInput = [],
    filterComplexStr = "",
    filterComplexStrConcat = "[0]";
  // https://superuser.com/a/1098315
  // https://github.com/my-telegram-bots/Pixiv_bot/blob/f67df3096c52d21aba9004bc0400c690a14edc97/handlers/pixiv/tools.js#L174
  for (let i = 0; i < len; i++) {
    const { file, delay } = frames[i];
    !useNativeFfmpeg && ffmpeg.FS("writeFile", file, framesData[i]);
    argsOfInput = argsOfInput.concat([
      "-i",
      useNativeFfmpeg ? `./tmp/${id}/${file}` : file,
    ]);
    filterComplexStrConcat += `[f${i + 1}]`;
    if (i === len - 1);
    else if (i === len - 2) {
      filterComplexStr +=
        `[${i + 1}]split[s${i + 1}][s${i + 2}]; ` +
        `[s${i + 1}]settb=1/1000,setpts=PTS+${delay / 1000}/TB[f${i + 1}]; ` +
        `[s${i + 2}]settb=1/1000,setpts=PTS+${delay / 1000}/TB[f${i + 2}]; ` +
        filterComplexStrConcat +
        `[f${i + 2}]concat=n=${len + 1},` +
        "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    } else
      filterComplexStr += `[${i + 1}]settb=1/1000,setpts=PTS+${
        delay / 1000
      }/TB[f${i + 1}]; `;
  }
  const convertTs = new Date().getTime(),
    saveName = isCliMode ? `${id}.mp4` : `${convertTs}-${id}.mp4`,
    savePath = isCliMode ? `./${saveName}` : `./src/${saveName}`;
  await (useNativeFfmpeg ? ffmpeg : ffmpeg.run)(
    ...argsOfInput,
    "-hide_banner",
    "-c:v",
    "libx264",
    "-filter_complex",
    filterComplexStr,
    "-fps_mode",
    "vfr",
    "-video_track_timescale",
    "1000",
    useNativeFfmpeg ? savePath : saveName
  );
  if (!useNativeFfmpeg) {
    fs.writeFileSync(savePath, ffmpeg.FS("readFile", saveName));
    argsOfInput.forEach(
      (filename, index) => index % 2 === 1 && ffmpeg.FS("unlink", filename)
    );
    ffmpeg.FS("unlink", saveName);
  }
  console.log(
    chalk.bgGreen("Post ") +
      chalk.bgCyan(`<${id}>`) +
      chalk.bgGreen(` has been saved to '${savePath}' successfully.`)
  );
  return true;
}

function removeConvertCache(id) {
  useNativeFfmpeg && fs.rmSync(`./tmp/${id}/`, { recursive: true });
  ugoiraConvertQueue.splice(ugoiraConvertQueue.indexOf(id), 1);
}

app.listen(port, () => {
  console.log(chalk.bgYellow(`Started on port ${port}`));
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default app;
