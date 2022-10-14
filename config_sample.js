export default {
  port: 8080,
  pixiv: {
    cookie: process.env.PIXIV_COOKIE || "PHPSESSID=YOUR PIXIV COOKIE HERE;",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.5304.29 Safari/537.36"
  },
  ffmpeg: {
    path: "LEAVE ALONE TO USE FFMPEG.WASM"
  }
}