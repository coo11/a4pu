import fs from 'fs';
import express from 'express';
import morgan from 'morgan';
import axios from 'axios';
import config from './config.js';
import AdmZip from 'adm-zip';
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';

const app = express();
app.use(morgan('dev'));
const port = process.env.PORT || config.port;

const ffmpegInstance = createFFmpeg({
    log: true
});
let ffmpegLoadingPromise = ffmpegInstance.load();

const ugoiraConvertQueue = [];

async function getFFmpeg() {
    if (ffmpegLoadingPromise) {
        await ffmpegLoadingPromise;
        ffmpegLoadingPromise = undefined;
    }

    return ffmpegInstance;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

app.get("/", async (req, res) => {
    res.status(200).send('Hello World!')
})

/* app.get("/favicon.ico", (req, res) => { return res.status(404).end(); }); */

const ugoiraMetaRequest = axios.create({
    baseURL: 'https://www.pixiv.net/ajax/',
    validateStatus: status => status < 500,
    headers: {
        'User-Agent': config.pixiv.ua,
        'Cookie': config.pixiv.cookie
    }
})

app.get(/\/ugoira2mp4\/\d+\.mp4/, async (req, res) => {
    let id = req.path.split(/\/|\./)?.[2];
    id = Number(id).toString();
    let cached = updateMp4Cache(),
        filename = cached[id];
    if (filename) {
        res.setHeader('content-type', 'video/mp4');
        res.send(fs.readFileSync(`./src/${filename}`));
        return;
    }
    let convert = await ugoira2mp4(id);
    if (convert) {
        cached = updateMp4Cache();
        res.setHeader('content-type', 'video/mp4');
        res.send(fs.readFileSync(`./src/${cached[id]}`));
        return;
    }
    res.status(500).send("<!DOCTYPE html><head></head><body><pre><html></html>Convert Failure.\n\nReason:\n1. Requested artwork ID is not a ugoira or not existed.\n2. Target file is too large.\n3. Invalid or expired cookie.</pre></body></html>");
})

function updateMp4Cache() {
    if (!fs.existsSync('./src/')) fs.mkdirSync('./src/');
    let files = fs.readdirSync('./src/');
    if (files.length > 4) {
        files.splice(0, 1);
        fs.rmSync(`./src/${files[0]}`, { force: true });
    }
    let cachedFiles = {}
    files.forEach(filename => { cachedFiles[filename.slice(14, -4)] = filename });
    return cachedFiles;
}

async function getUgoiraData(url, savePath) {
    url = url.replace('https://i.pximg.net/', 'https://i-cf.pximg.net/');

    try {
        let data = (await axios({
            url: url,
            method: 'GET',
            responseType: 'arraybuffer',
            headers: { 'User-Agent': config.pixiv.ua, 'Referer': 'https://www.pixiv.net/' }
        })).data;
        let zip = new AdmZip(data);
        zip.extractAllTo(savePath, true);
        data = null;
        zip = null;
        return true
    } catch (e) {
        console.log(e);
    }
    return false
}

async function ugoira2mp4(id, retryTimes = 0) {
    if (retryTimes > 3) {
        console.error("Retry times exceed 3.")
        return;
    }
    if (ugoiraConvertQueue.length > 4 || ugoiraConvertQueue.indexOf(id) > -1) {
        await sleep(1000);
        return await ugoira2mp4(id, retryTimes);
    }
    ugoiraConvertQueue.push(id);
    let tempPath = `./tmp/${id}/`
    if (!fs.existsSync(tempPath)) {
        fs.mkdirSync(tempPath, { recursive: true });
    } else {
        fs.rmSync(tempPath, { recursive: true });
        fs.mkdirSync(tempPath, { recursive: true });
    }

    let success = false;
    try {
        const meta = (await ugoiraMetaRequest(`/illust/${id}/ugoira_meta`))?.data
        if (meta && !meta.error) {
            const { originalSrc, frames } = meta.body;
            const status = await getUgoiraData(originalSrc, tempPath);
            if (status) {
                success = await frames2mp4(frames, id);
            }
        }
    } catch (e) {
        console.error('\nERROR');
        console.log(e);
        ugoiraConvertQueue.splice(ugoiraConvertQueue.indexOf(id), 1)
        await sleep(2000)
        return await ugoira2mp4(id, retryTimes + 1)
    }
    removeConvertCache(id);
    return success;
}

async function frames2mp4(frames, id = '1') {
    const ffmpeg = await getFFmpeg();
    const len = frames.length;
    let argsOfInput = [],
        filterComplexStr = '',
        filterComplexStrConcat = '[0]';
    // https://superuser.com/a/1098315
    // https://github.com/my-telegram-bots/Pixiv_bot/blob/f67df3096c52d21aba9004bc0400c690a14edc97/handlers/pixiv/tools.js#L174
    for (let i = 0; i < len; i++) {
        const { file, delay } = frames[i];
        ffmpeg.FS('writeFile', file, await fetchFile(`./tmp/${id}/${file}`));
        argsOfInput = argsOfInput.concat(['-i', file]);
        filterComplexStrConcat += `[f${i + 1}]`;
        if (i === len - 1);
        else if (i === len - 2) {
            filterComplexStr += `[${i + 1}]split[s${i + 1}][s${i + 2}]; ` +
                `[s${i + 1}]settb=1/1000,setpts=PTS+${delay / 1000}/TB[f${i + 1}]; ` +
                `[s${i + 2}]settb=1/1000,setpts=PTS+${delay / 1000}/TB[f${i + 2}]; ` +
                filterComplexStrConcat + `[f${i + 2}]concat=n=${len + 1},` +
                'scale=trunc(iw/2)*2:trunc(ih/2)*2';
        } else filterComplexStr += `[${i + 1}]settb=1/1000,setpts=PTS+${delay / 1000}/TB[f${i + 1}]; `
    }
    const convertTs = new Date().getTime(),
        saveName = `${convertTs}-${id}.mp4`;
    await ffmpeg.run(...argsOfInput,
        '-hide_banner',
        '-c:v', 'libx264',
        '-filter_complex', filterComplexStr,
        '-vsync', 'vfr',
        '-r', '1000',
        '-video_track_timescale', '1000',
        saveName)
    fs.writeFileSync(`./src/${saveName}`, ffmpeg.FS('readFile', saveName));
    argsOfInput.forEach((filename, index) => index % 2 === 1 && ffmpeg.FS('unlink', filename));
    ffmpeg.FS('unlink', saveName);
    return true;
}

function removeConvertCache(id) {
    fs.rmSync(`./tmp/${id}/`, { recursive: true, force: true });
    ugoiraConvertQueue.splice(ugoiraConvertQueue.indexOf(id), 1);
}

app.listen(port, () => { console.log(`Started on port ${port}`); });

export default app;