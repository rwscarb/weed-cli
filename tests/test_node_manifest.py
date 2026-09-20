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


def test_a_file_in_a_subdirectory_resolves_there_when_last_path_is_stale(tmp_path):
    """Ryan: "can we support subdirectories?" ott records orig_path relative
    to the archive root, so a file added from a subdirectory is found
    there when its absolute last_path is from another machine (the Docker
    bind mount case) -- not looked for by bare name at the root."""
    entry = make_fake_archive(tmp_path, name='Live/Paris 1993/set.mkv')
    entry['last_path'] = '/somewhere/else/set.mkv'
    assert node.resolve_file_path(entry, str(tmp_path)) == os.path.join(str(tmp_path), 'Live', 'Paris 1993', 'set.mkv')
    kept, by_hash = node._load_hostable_entries(str(tmp_path), None)
    assert [e['sha256'] for e in kept] == [entry['sha256']]


def test_the_same_name_in_two_subdirectories_is_two_files(tmp_path):
    a = make_fake_archive(tmp_path, name='Studio/take.mp4')
    b = make_fake_archive(tmp_path, name='Live/take.mp4')
    entries = node.load_manifest_entries(str(tmp_path))
    assert sorted(e['sha256'] for e in entries) == sorted([a['sha256'], b['sha256']])
    assert all(e['name'] == 'take.mp4' for e in entries)              # the bare name is what gets announced
    # --file by the archive-relative path picks one; by bare name, both
    assert [e['sha256'] for e in node.load_manifest_entries(str(tmp_path), 'Live/take.mp4')] == [b['sha256']]
    assert len(node.load_manifest_entries(str(tmp_path), 'take.mp4')) == 2
    assert node.find_manifest_entry(str(tmp_path), 'Studio/take.mp4')['sha256'] == a['sha256']


def test_entry_rel_path_never_climbs_out_of_the_archive():
    assert node.entry_rel_path({'name': 'x.mp4', 'orig_path': '../../etc/x.mp4'}) == 'x.mp4'
    assert node.entry_rel_path({'name': 'x.mp4', 'orig_path': '/abs/x.mp4'}) == 'x.mp4'
    assert node.entry_rel_path({'name': 'x.mp4', 'orig_path': 'Sub\\x.mp4'}) == 'Sub/x.mp4'
    assert node.entry_rel_path({'name': 'x.mp4'}) == 'x.mp4'


def test_a_file_moved_into_a_folder_and_fixed_with_ott_fix_renames_is_found_by_its_paths_tail(tmp_path):
    """Ryan: "my old files which I moved into a folder ... I ran `ott
    fix-renames` but it still shows them all as getting skipped".
    fix-renames rewrites last_path (absolute, on the host machine) and
    leaves orig_path as the old bare name; inside the container that
    last_path doesn't exist. The node now tries the trailing segments of
    last_path under the archive, so the file is found in its new folder,
    hosted, and announced with that folder."""
    entry = make_fake_archive(tmp_path, name='set.mkv')
    os.makedirs(tmp_path / 'Live' / 'Paris 1993')
    os.rename(tmp_path / 'set.mkv', tmp_path / 'Live' / 'Paris 1993' / 'set.mkv')
    entry['last_path'] = '/home/ryan/share/Live/Paris 1993/set.mkv'     # what fix-renames wrote, on the host
    assert entry['orig_path'] == 'set.mkv'                                # and what it left alone
    assert node.resolve_file_path(entry, str(tmp_path)) == os.path.join(str(tmp_path), 'Live', 'Paris 1993', 'set.mkv')
    assert node.entry_archive_rel(entry, str(tmp_path)) == 'Live/Paris 1993/set.mkv'
    with open(os.path.join(str(tmp_path), '.ott', 'manifest.jsonl'), 'w') as f:
        f.write(__import__('json').dumps(entry) + '\n')
    kept, by_hash = node._load_hostable_entries(str(tmp_path), None)
    assert [e['sha256'] for e in kept] == [entry['sha256']]


def test_a_file_moved_into_a_folder_with_an_untouched_manifest_is_found_by_name_and_size(tmp_path):
    """Ryan: "I have files in ./share/folder, but they're not showing up
    anymore". Nothing on the entry says where the file went (last_path
    still the old root location, orig_path the bare name), so the node
    looks for it by name anywhere under the archive, taking the one of
    the right size when the name repeats."""
    entry = make_fake_archive(tmp_path, name='set.mkv', size=120_000)
    os.makedirs(tmp_path / 'Mid-Air Thief' / 'Crumbling')
    os.rename(tmp_path / 'set.mkv', tmp_path / 'Mid-Air Thief' / 'Crumbling' / 'set.mkv')
    os.makedirs(tmp_path / 'Other')
    with open(tmp_path / 'Other' / 'set.mkv', 'wb') as f:                          # a different file with the same name
        f.write(b'x' * 10)
    assert not os.path.exists(entry['last_path'])
    node._archive_index_cache.clear()
    assert node.resolve_file_path(entry, str(tmp_path)) == os.path.join(str(tmp_path), 'Mid-Air Thief', 'Crumbling', 'set.mkv')
    assert node.entry_archive_rel(entry, str(tmp_path)) == 'Mid-Air Thief/Crumbling/set.mkv'
    kept, by_hash = node._load_hostable_entries(str(tmp_path), None)
    assert [e['sha256'] for e in kept] == [entry['sha256']]


def test_discover_grouping_keeps_a_folder_any_publisher_named():
    """Ryan: "the folder still doesn't show up in Discover. It does show
    up in Downloads though". One row per content hash keeps the newest
    publisher's fields; if that publisher (an older build, a mirror)
    announced without a folder, the folder comes from one that did."""
    rows = [
        {'content_hash': 'a' * 64, 'signer_pubkey': 'old', 'host': '1.2.3.4:9201', 'title': 'set.mkv', 'ts': 200},
        {'content_hash': 'a' * 64, 'signer_pubkey': 'new', 'host': '5.6.7.8:9201', 'title': 'set.mkv', 'ts': 100, 'folder': 'Live'},
        {'content_hash': 'b' * 64, 'signer_pubkey': 'old', 'host': '1.2.3.4:9201', 'title': 'root.mkv', 'ts': 300},
    ]
    merged = {r['content_hash']: r for r in node.group_discover_by_content(rows)}
    assert merged['a' * 64]['host'] == '1.2.3.4:9201' and merged['a' * 64]['folder'] == 'Live'
    assert 'folder' not in merged['b' * 64]
