"""
node.py's manifest/chunk-loading logic -- pure filesystem + JSON, no
network, no servers. Includes a regression test for the real incident
this session: an .mp3 in the same archive_dir as a hosted video crashed
`host` entirely (see node.load_manifest_entries's own docstring).
"""
import os

import pytest

import node
from testutil import make_fake_archive


def test_load_manifest_entries_single_video(tmp_path):
    entry = make_fake_archive(tmp_path, name='good.mp4')
    entries = node.load_manifest_entries(str(tmp_path))
    assert [e['sha256'] for e in entries] == [entry['sha256']]


def test_load_manifest_entries_filters_non_video(tmp_path):
    """The original bug this filter exists for: a non-chunked file
    (originally an mp3, back when ott's extension-based is_video() typed
    it 'image' for lack of any 'audio' type at all -- see
    test_load_manifest_entries_includes_audio_alongside_video below for
    that no longer being true) sitting in the same archive_dir used to
    poison-pill hosting the whole directory -- host <dir> with no --file
    should just skip a genuinely non-hostable entry (a real photo, here)
    and host the real video."""
    video = make_fake_archive(tmp_path, name='good.mp4')
    make_fake_archive(tmp_path, name='photo.jpg', content_type='image')

    entries = node.load_manifest_entries(str(tmp_path))
    assert [e['sha256'] for e in entries] == [video['sha256']]


def test_load_manifest_entries_includes_audio_alongside_video(tmp_path):
    """Real ask: support audio (mp3, etc.) in addition to video. ott's
    own cmd_add now chunks audio the same way it always has video (see
    its own is_audio()), so an audio-typed manifest entry has real chunk
    data too -- this is the one place every hosting path (weed.py,
    shell.py, web_ui.py) filters on 'is this actually hostable', and it
    needs to say yes to both now, not just video."""
    video = make_fake_archive(tmp_path, name='good.mp4')
    audio = make_fake_archive(tmp_path, name='song.mp3', content_type='audio')

    entries = node.load_manifest_entries(str(tmp_path))
    assert {e['sha256'] for e in entries} == {video['sha256'], audio['sha256']}
    # the audio entry got real chunk data, not the image-style single
    # whole-file hash with no chunks
    audio_entry = next(e for e in entries if e['sha256'] == audio['sha256'])
    assert audio_entry['n_chunks'] > 1
    assert node.load_leaves(str(tmp_path), audio['sha256']) is not None


def test_load_manifest_entries_explicit_non_video_file_errors_clearly(tmp_path):
    make_fake_archive(tmp_path, name='good.mp4')
    make_fake_archive(tmp_path, name='photo.jpg', content_type='image')

    with pytest.raises(SystemExit, match='no hostable video/audio file found'):
        node.load_manifest_entries(str(tmp_path), 'photo.jpg')


def test_load_manifest_entries_no_manifest_at_all(tmp_path):
    with pytest.raises(SystemExit, match='no .ott/manifest.jsonl'):
        node.load_manifest_entries(str(tmp_path))


def test_load_manifest_entries_dedupes_by_name_last_write_wins(tmp_path):
    """Two manifest lines for the same file name (re-added after a real
    edit) should collapse to the newer entry, not double-list it."""
    os.makedirs(os.path.join(tmp_path, '.ott'), exist_ok=True)
    manifest = os.path.join(tmp_path, '.ott', 'manifest.jsonl')
    old = {'sha256': 'a' * 64, 'name': 'clip.mp4', 'orig_path': 'clip.mp4',
           'last_path': str(tmp_path / 'clip.mp4'), 'size': 1, 'added': '2020-01-01T00:00:00Z',
           'type': 'video', 'n_chunks': 1, 'chunk_size': 65536}
    new = {**old, 'sha256': 'b' * 64, 'added': '2026-01-01T00:00:00Z'}
    with open(manifest, 'w') as f:
        f.write('%s\n%s\n' % (__import__('json').dumps(old), __import__('json').dumps(new)))

    entries = node.load_manifest_entries(str(tmp_path))
    assert len(entries) == 1
    assert entries[0]['sha256'] == 'b' * 64


def test_load_leaves_round_trips_real_chunks(tmp_path):
    entry = make_fake_archive(tmp_path, name='good.mp4', size=200_000, chunk_size=65_536)
    leaves = node.load_leaves(str(tmp_path), entry['sha256'])
    assert len(leaves) == entry['n_chunks']
    assert len(leaves) > 1  # 200_000 bytes / 65_536 chunk_size genuinely spans multiple chunks


def test_load_leaves_missing_chunks_file_errors_clearly(tmp_path):
    entry = make_fake_archive(tmp_path, name='good.mp4', video=False)
    with pytest.raises(SystemExit, match='no chunks file at'):
        node.load_leaves(str(tmp_path), entry['sha256'])


def test_resolve_file_path_prefers_last_path_when_it_exists(tmp_path):
    entry = make_fake_archive(tmp_path, name='good.mp4')
    resolved = node.resolve_file_path(entry, str(tmp_path))
    assert resolved == entry['last_path']
    assert os.path.exists(resolved)


def test_resolve_file_path_falls_back_when_last_path_is_stale(tmp_path):
    """last_path is recorded at archive time on whatever machine ran
    `ott add` -- trusting it unconditionally breaks the moment archive_dir
    is the same content mounted somewhere else (see node.py's own
    docstring for the real Docker-bind-mount incident this guards)."""
    entry = make_fake_archive(tmp_path, name='good.mp4')
    entry['last_path'] = '/nonexistent/path/on/a/different/machine/good.mp4'
    resolved = node.resolve_file_path(entry, str(tmp_path))
    assert resolved == os.path.join(str(tmp_path), 'good.mp4')
