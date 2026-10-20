"""Prepare a compatible MP4, then publish it atomically through the Worker.

GitHub OIDC authenticates this workflow; no cloud credential is stored in GitHub.
The original file is never modified. Only validated output is marked playable.
"""
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ORIGIN = os.environ.get('PREPARATION_API_ORIGIN', '')
JOB = os.environ.get('PREPARATION_JOB_ID', '')
BASE = f'{ORIGIN}/api/preparation/jobs/{JOB}'
TOKEN = None
TOKEN_AT = 0


def identity():
    global TOKEN, TOKEN_AT
    if TOKEN and time.time() - TOKEN_AT < 120:
        return TOKEN
    url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=minattoflix-media'
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    with urllib.request.urlopen(request, timeout=30) as response:
        TOKEN = json.load(response)['value']
    TOKEN_AT = time.time()
    print('::add-mask::' + TOKEN, flush=True)
    return TOKEN


def request(path, method='GET', data=None, headers=None):
    values = {'Authorization': 'Bearer ' + identity(), **(headers or {})}
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        values['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path, data=data, headers=values, method=method)
    return urllib.request.urlopen(req, timeout=120)


def api(path, method='POST', data=None):
    with request(path, method, data) as response:
        return json.load(response)


def download(path):
    offset = 0
    with path.open('wb') as output:
        while True:
            with request('/source', headers={'Range': f'bytes={offset}-{offset + 4194303}'}) as response:
                if 'text/html' in response.headers.get('Content-Type', ''):
                    raise RuntimeError('Source returned HTML instead of media')
                content_range = response.headers.get('Content-Range', '')
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', content_range)
                if response.status == 206 and (not match or int(match[1]) != offset):
                    raise RuntimeError('Invalid source byte range')
                if match and int(match[3]) > shutil.disk_usage(path.parent).free + offset - 3 * 1024**3:
                    raise RuntimeError('Source is too large for this executor')
                count = 0
                while block := response.read(1024 * 1024):
                    output.write(block)
                    count += len(block)
                if not count:
                    raise RuntimeError('Empty media range')
                offset += count
                if response.status == 200 or match and offset >= int(match[3]):
                    break
    print(f'Source downloaded: {offset} bytes', flush=True)


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)], text=True))


def convert(source, target, on_progress=None):
    info = probe(source)
    videos = [stream for stream in info['streams'] if stream['codec_type'] == 'video' and not stream.get('disposition', {}).get('attached_pic')]
    if not videos:
        raise RuntimeError('No video track')
    video = videos[0]
    duration = float(info.get('format', {}).get('duration', 0))
    command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-fflags', '+genpts', '-i', str(source), '-map', f"0:{video['index']}"]
    for stream in info['streams']:
        if stream['codec_type'] == 'audio' or stream['codec_type'] == 'subtitle' and stream.get('codec_name') in ('subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'):
            command += ['-map', f"0:{stream['index']}"]
    filters = []
    if video.get('color_transfer') in ('smpte2084', 'arib-std-b67'):
        filters += ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'tonemap=hable', 'zscale=p=bt709:t=bt709:m=bt709:r=tv']
    filters += ["scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", 'format=yuv420p']
    command += ['-vf', ','.join(filters), '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-maxrate', '4M', '-bufsize', '8M',
                '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-af', 'aresample=async=1:first_pts=0', '-c:s', 'mov_text',
                '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-progress', 'pipe:1', '-nostats', str(target)]
    last = 0
    with subprocess.Popen(command, stdout=subprocess.PIPE, text=True) as process:
        for line in process.stdout:
            if line.startswith('out_time_us=') and duration > 0:
                try:
                    progress = min(85, 10 + int(int(line.strip().split('=')[1]) / 1000000 / duration * 75))
                    if progress >= last + 10:
                        if on_progress:
                            on_progress(progress)
                        last = progress
                        print(f'Encoding: {progress}%', flush=True)
                except ValueError:
                    pass
        if process.wait() != 0:
            raise RuntimeError('FFmpeg conversion failed')
    output = probe(target)
    if not any(s.get('codec_name') == 'h264' and s.get('pix_fmt') == 'yuv420p' for s in output['streams']):
        raise RuntimeError('Output video validation failed')
    output_duration = float(output.get('format', {}).get('duration', 0))
    if output_duration <= 0 or duration > 0 and abs(output_duration-duration) > max(2, duration*.01):
        raise RuntimeError('Output duration validation failed')
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(target), '-t', '5', '-f', 'null', '-'], check=True)
    return output_duration


def upload(path, duration):
    api('/upload', data={})
    parts = []
    with path.open('rb') as source:
        while block := source.read(16 * 1024 * 1024):
            number = len(parts) + 1
            for attempt in range(4):
                try:
                    with request(f'/parts/{number}', 'PUT', block, {'Content-Type': 'application/octet-stream'}) as response:
                        parts.append(json.load(response))
                    break
                except (urllib.error.URLError, TimeoutError):
                    if attempt == 3:
                        raise
                    time.sleep(2 ** attempt)
    api('/complete', data={'parts': parts, 'duration': duration})
    print('Validated compatible video is ready', flush=True)


def main():
    if ORIGIN != 'https://minattoflix-v2.rafalegollas.workers.dev' or not re.fullmatch(r'[0-9a-f-]{36}', JOB):
        raise SystemExit('Invalid preparation destination or job identifier')
    work = Path(os.environ.get('RUNNER_TEMP', '.')) / ('media-' + JOB)
    work.mkdir(parents=True, exist_ok=True)
    try:
        api('/status', data={'state': 'processing', 'progress': 1})
        original, prepared = work / 'source.media', work / 'compatible.mp4'
        download(original)
        duration = convert(original, prepared, lambda progress: api('/status', data={'state': 'processing', 'progress': progress}))
        upload(prepared, duration)
    except Exception:
        try:
            api('/status', data={'state': 'failed', 'progress': 0})
        except Exception:
            pass
        raise


if __name__ == '__main__':
    main()
