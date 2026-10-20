"""Integration test using synthetic content; no library file or cloud access."""
import subprocess
import tempfile
from pathlib import Path
from prepare_media import convert, probe


def main():
    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        subtitle = folder / 'pt.srt'
        subtitle.write_text('1\n00:00:00,100 --> 00:00:02,500\nLegenda de teste\n', encoding='utf-8')
        source, output = folder / 'source.mkv', folder / 'compatible.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
                        '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'lavfi', '-i', 'sine=frequency=880', '-i', str(subtitle),
                        '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-t', '3', '-c:v', 'libx264',
                        '-c:a', 'ac3', '-c:s', 'srt', '-metadata:s:a:0', 'language=por', '-metadata:s:a:1', 'language=eng',
                        '-metadata:s:s:0', 'language=por', str(source)], check=True)
        assert 2.5 < convert(source, output) < 3.5
        info = probe(output)
        videos = [stream for stream in info['streams'] if stream['codec_type'] == 'video']
        audios = [stream for stream in info['streams'] if stream['codec_type'] == 'audio']
        subtitles = [stream for stream in info['streams'] if stream['codec_type'] == 'subtitle']
        assert len(videos) == 1 and videos[0]['codec_name'] == 'h264'
        assert videos[0]['pix_fmt'] == 'yuv420p' and videos[0]['width'] <= 1280
        assert len(audios) == 2 and all(stream['codec_name'] == 'aac' for stream in audios)
        assert [stream.get('tags', {}).get('language') for stream in audios] == ['por', 'eng']
        assert len(subtitles) == 1 and subtitles[0]['codec_name'] == 'mov_text'
        assert source.is_file(), 'Original must be preserved'
        data = output.read_bytes()
        assert data.index(b'moov') < data.index(b'mdat'), 'MP4 must have faststart metadata'
        subprocess.run(['ffmpeg', '-v', 'error', '-ss', '1', '-i', str(output), '-t', '1', '-f', 'null', '-'], check=True)
        print('PASS: H.264/AAC, dual audio languages, text subtitles, faststart, seek and original preservation')


if __name__ == '__main__':
    main()
