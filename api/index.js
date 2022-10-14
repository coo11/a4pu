import express from 'express';
import morgan from 'morgan';
import axios from 'axios';
import AdmZip from 'adm-zip';
import chalk from 'chalk';
import { createFFmpeg } from '@ffmpeg/ffmpeg';
import config from '../config.js';

const ugoiraConvertQueue = [];
const mp4outputQueue = new Map(); // In case not run second time if receive HTTP 304 
const ugoiraMetaRequest = axios.create({
    baseURL: 'https://www.pixiv.net/ajax/',
    validateStatus: status => status < 500,
    headers: {
        'User-Agent': config.pixiv.ua,
        'Cookie': config.pixiv.cookie
    }
})

let ffmpegInstance = createFFmpeg({ corePath: '../../../core/dist/ffmpeg-core.js', log: true }),
    ffmpegLoadingPromise = ffmpegInstance.load();

async function initFFmpeg() {
    if (ffmpegLoadingPromise) {
        await ffmpegLoadingPromise;
        ffmpegLoadingPromise = undefined;
    }
    return ffmpegInstance;
}

const app = express();
app.use(morgan('dev'));
const port = process.env.PORT || config.port;

app.get("/", async (req, res) => { res.status(200).send('Hello World!') })

/* app.get("/favicon.ico", (req, res) => { return res.status(404).end(); }); */

app.get(/\/ugoira2mp4\/\d+\.mp4/, async (req, res) => {
    let id = req.path.split(/\/|\./)?.[2];
    id = Number(id).toString();
    if (mp4outputQueue.has(id)) {
        res.setHeader('content-type', 'video/mp4');
        res.send(mp4outputQueue.get(id).opt);
        return;
    }
    let opt = await ugoira2mp4(id);
    if (opt) {
        res.setHeader('content-type', 'video/mp4');
        res.send(mp4outputQueue.get(id).opt);
        return;
    }
    res.status(500).send("<!DOCTYPE html><head></head><body><pre><html></html>Convert Failure.\n\nReason:\n1. Requested artwork ID is not a ugoira or not existed.\n2. Target file is too large.\n3. Invalid or expired cookie.</pre></body></html>");
})

async function getUgoiraData(url) {
    url = url.replace('https://i.pximg.net/', 'https://i-cf.pximg.net/');
    try {
        let data = (await axios({
            url: url,
            method: 'GET',
            responseType: 'arraybuffer',
            headers: { 'User-Agent': config.pixiv.ua, 'Referer': 'https://www.pixiv.net/' }
        })).data;
        let zip = new AdmZip(data);
        let framesData = [];
        zip.forEach(zipEntry => framesData.push(zipEntry.getData()));
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
        console.log(chalk.bgRed("Retry times exceed 3."))
        return;
    }
    if (ugoiraConvertQueue.length > 4 || ugoiraConvertQueue.indexOf(id) > -1) {
        await sleep(1000);
        return await ugoira2mp4(id, retryTimes);
    }
    ugoiraConvertQueue.push(id);

    let success = false;
    try {
        const meta = (await ugoiraMetaRequest(`/illust/${id}/ugoira_meta`))?.data
        if (meta && !meta.error) {
            const { originalSrc, frames } = meta.body;
            const framesData = await getUgoiraData(originalSrc, `./tmp/${id}/`);
            if (framesData) {
                success = await frames2mp4(frames, framesData, id);
            }
        }
    } catch (e) {
        console.log(e);
        ugoiraConvertQueue.splice(ugoiraConvertQueue.indexOf(id), 1);
        await sleep(2000)
        return await ugoira2mp4(id, retryTimes + 1)
    }
    ugoiraConvertQueue.splice(ugoiraConvertQueue.indexOf(id), 1);
    return success;
}

async function frames2mp4(frames, framesData, id = '1') {
    const ffmpeg = await initFFmpeg();
    const len = frames.length;
    let argsOfInput = [],
        filterComplexStr = '',
        filterComplexStrConcat = '[0]';
    // https://superuser.com/a/1098315
    // https://github.com/my-telegram-bots/Pixiv_bot/blob/f67df3096c52d21aba9004bc0400c690a14edc97/handlers/pixiv/tools.js#L174
    for (let i = 0; i < len; i++) {
        const { file, delay } = frames[i];
        ffmpeg.FS('writeFile', file, framesData[i]);
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
    framesData = undefined;
    const saveName = `${id}.mp4`;
    await ffmpeg.run(...argsOfInput,
        '-hide_banner',
        '-c:v', 'libx264',
        '-filter_complex', filterComplexStr,
        '-vsync', 'vfr',
        '-r', '1000',
        '-video_track_timescale', '1000',
        saveName);
    let opt = Buffer.from(ffmpeg.FS('readFile', saveName), 'binary');
    argsOfInput.forEach((filename, index) => index % 2 === 1 && ffmpeg.FS('unlink', filename));
    ffmpeg.FS('unlink', saveName);
    updateOutputQueue({ id, ts: (new Date()).getTime(), opt });
    return true;
}

function updateOutputQueue(newOpt) {
    let cachedVideos = [...mp4outputQueue.keys()];
    cachedVideos.sort((a, b) => mp4outputQueue.get(b).ts - mp4outputQueue.get(a).ts)
    if (cachedVideos.length > 3) {
        mp4outputQueue.delete(cachedVideos[0]);
    }
    mp4outputQueue.set(newOpt.id, { ts: newOpt.ts, opt: newOpt.opt })
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

app.listen(port, () => { console.log(chalk.bgYellow(`Started on port ${port}`)); });