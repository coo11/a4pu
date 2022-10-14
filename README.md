# Generate VFR Video from Pixiv ugoira

> Try to use ffmpeg.wasm in FaaS but failure.

## Practice summary

**Q**: How to deploy this API to Vercel? I always find this shit error "Cannot find module '@ffmpeg/core'" in function log.

**A**: Maybe this module was excluded while building because you didn't import it directly. So you have to ensure this module in your build cache. To solve this problem, do the following steps:

  1. Tell FFmpeg.wasm where `@ffmpeg/core` is:

```javascript
createFFmpeg({
    corePath: '../../../core/dist/ffmpeg-core.js'
})
```

  2. Tell Vercel [do not exclude](https://vercel.com/docs/project-configuration#project-configuration/functions/value-definition) module files:

```JSON
{
  "functions": {
    "api/index.js": {
      "includeFiles": "node_modules/@ffmpeg/core/**"
    }
  }
}
```

  3. OK. Just redeploy it. Certainly you'll find a new problem: Vercel has a 10-second running limination. At least in Oct, 2022. So it'll time out most of the time! XDDDDDDDDDDDD

What's more, given that your serverless function runs in a read-only file system, you should remove all the code related to disk write operation.