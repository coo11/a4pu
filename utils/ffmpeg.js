import { spawn } from 'child_process';
import config from '../config.js';

const spawnAsync = async (command, option) => {
    return new Promise((resolve, reject) => {
        const _process = spawn(command, option)

        if (_process.stdout === null) {
            return reject(new Error('stdout is not defined'))
        }
        if (_process.stderr === null) {
            return reject(new Error('stderr is not defined'))
        }
        _process.stderr.pipe(process.stderr)
        _process.stdout.pipe(process.stdout)
        _process.on('error', (err) => {
            return reject(err)
        })
        _process.on('disconnect', () => {
            return reject(new Error('disconnected'))
        })
        _process.on('message', (message) => {
            console.log(message)
        })
        _process.on('exit', (code) => {
            return resolve(code)
        })
        _process.on('close', (code) => {
            return resolve(code)
        })
    })
}

export async function ffmpeg() {
    return await spawnAsync(config.ffmpeg.path, ['-y', ...arguments])
}