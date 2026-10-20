"""Create an iPhone-compatible copy locally, with no cloud processing charge."""
import argparse
import shutil
from pathlib import Path
from prepare_media import convert


def main():
    parser = argparse.ArgumentParser(description='Preparar cópia H.264/AAC para o MinattoFlix no iPhone.')
    parser.add_argument('source', type=Path, help='Arquivo original de vídeo')
    parser.add_argument('--output', type=Path, help='Arquivo MP4 de saída; nunca pode substituir o original')
    args = parser.parse_args()
    source = args.source.resolve()
    target = (args.output or source.with_name(source.stem + '.compatible.mp4')).resolve()
    if not source.is_file():
        parser.error('Arquivo original não encontrado.')
    if target == source or target.exists() or target.suffix.lower() != '.mp4':
        parser.error('Escolha um MP4 novo para preservar os arquivos existentes.')
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        parser.error('Instale FFmpeg/FFprobe e adicione a pasta bin ao PATH.')
    target.parent.mkdir(parents=True, exist_ok=True)
    duration = convert(source, target)
    print(f'Cópia validada: {target}\nDuração: {duration:.1f}s. Envie a cópia à sua fonte e sincronize o catálogo.')


if __name__ == '__main__':
    main()
