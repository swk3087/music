'use client';

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteFolder,
  deleteTrack,
  ensureDefaults,
  FolderRecord,
  formatBytes,
  formatTime,
  getFolders,
  getSettings,
  getTracks,
  RepeatMode,
  ROOT_FOLDER_ID,
  saveFolder,
  saveSettings,
  saveTrack,
  TrackRecord,
} from '@/lib/db';

type TrackView = TrackRecord & { url: string };

const repeatOrder: RepeatMode[] = ['off', 'all', 'one'];

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function readDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    audio.preload = 'metadata';
    audio.src = url;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.remove();
    };

    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      cleanup();
      resolve(duration);
    };

    audio.onerror = () => {
      cleanup();
      resolve(0);
    };
  });
}

function getTrackArtist(name: string): string {
  const [artistGuess] = name.split('-');
  return artistGuess?.trim() || 'Unknown Artist';
}

export function MuserApp() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const settingsSaveTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [ready, setReady] = useState(false);
  const [tracks, setTracks] = useState<TrackView[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState(ROOT_FOLDER_ID);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [statusMessage, setStatusMessage] = useState('브라우저 저장공간에 음악을 보관하는 오프라인 플레이어');
  const [newFolderName, setNewFolderName] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const visibleTracks = useMemo(() => {
    if (currentFolderId === ROOT_FOLDER_ID) {
      return tracks;
    }

    return tracks.filter((track) => track.folderId === currentFolderId);
  }, [currentFolderId, tracks]);

  const currentTrack = useMemo(
    () => tracks.find((track) => track.id === currentTrackId) ?? null,
    [currentTrackId, tracks],
  );

  const storageStats = useMemo(() => {
    const totalBytes = tracks.reduce((sum, track) => sum + track.size, 0);
    return {
      count: tracks.length,
      totalBytes,
    };
  }, [tracks]);

  useEffect(() => {
    let mounted = true;

    async function boot() {
      await ensureDefaults();
      const [storedTracks, storedFolders, settings] = await Promise.all([getTracks(), getFolders(), getSettings()]);

      if (!mounted) {
        return;
      }

      const hydratedTracks = storedTracks.map((track) => ({
        ...track,
        url: URL.createObjectURL(track.blob),
      }));

      setTracks(hydratedTracks);
      setFolders(storedFolders);
      setCurrentTrackId(settings.currentTrackId);
      setCurrentFolderId(settings.currentFolderId);
      setRepeatMode(settings.repeatMode);
      setShuffleEnabled(settings.shuffleEnabled);
      setCurrentTime(settings.currentTime);
      setReady(true);
    }

    void boot();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }

    void saveSettings({
      currentTrackId,
      currentTime,
      currentFolderId,
      repeatMode,
      shuffleEnabled,
    });
  }, [currentFolderId, currentTrackId, ready, repeatMode, shuffleEnabled]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    if (settingsSaveTimeoutRef.current) {
      window.clearTimeout(settingsSaveTimeoutRef.current);
    }

    settingsSaveTimeoutRef.current = window.setTimeout(() => {
      void saveSettings({
        currentTrackId,
        currentTime,
        currentFolderId,
        repeatMode,
        shuffleEnabled,
      });
    }, isPlaying ? 1500 : 250);

    return () => {
      if (settingsSaveTimeoutRef.current) {
        window.clearTimeout(settingsSaveTimeoutRef.current);
      }
    };
  }, [currentFolderId, currentTime, currentTrackId, isPlaying, ready, repeatMode, shuffleEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    void navigator.serviceWorker.register('/sw.js');
  }, []);

  useEffect(() => {
    return () => {
      tracks.forEach((track) => URL.revokeObjectURL(track.url));
    };
  }, [tracks]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio || !currentTrack) {
      return;
    }

    if (audio.dataset.trackId !== currentTrack.id) {
      audio.src = currentTrack.url;
      audio.dataset.trackId = currentTrack.id;
      audio.currentTime = currentTime;
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.name,
        artist: currentTrack.artist,
        album: 'Muser Library',
      });
    }
  }, [currentTime, currentTrack]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio || !currentTrack) {
      return;
    }

    if (isPlaying) {
      void audio.play().catch(() => {
        setIsPlaying(false);
      });
      return;
    }

    audio.pause();
  }, [currentTrack, isPlaying]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) {
      return;
    }

    navigator.mediaSession.setActionHandler('play', () => {
      void togglePlayback(true);
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      void togglePlayback(false);
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      playAdjacent(-1);
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      playAdjacent(1);
    });
  }, [currentTrackId, shuffleEnabled, repeatMode, visibleTracks]);

  async function refreshLibrary() {
    const [storedTracks, storedFolders] = await Promise.all([getTracks(), getFolders()]);
    setTracks((previous) => {
      previous.forEach((track) => URL.revokeObjectURL(track.url));
      return storedTracks.map((track) => ({
        ...track,
        url: URL.createObjectURL(track.blob),
      }));
    });
    setFolders(storedFolders);
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith('audio/'));

    if (!files.length) {
      setStatusMessage('오디오 파일을 선택해 주세요.');
      return;
    }

    setIsBusy(true);
    setStatusMessage(`${files.length}개의 음악을 저장 중...`);

    for (const file of files) {
      const duration = await readDuration(file);
      await saveTrack({
        id: createId('track'),
        name: file.name.replace(/\.[^/.]+$/, ''),
        artist: getTrackArtist(file.name.replace(/\.[^/.]+$/, '')),
        fileType: file.type,
        size: file.size,
        duration,
        folderId: currentFolderId,
        createdAt: Date.now(),
        blob: file,
      });
    }

    await refreshLibrary();
    setIsBusy(false);
    setStatusMessage(`${files.length}개의 음악을 브라우저 저장공간에 보관했어요.`);
    event.target.value = '';
  }

  async function togglePlayback(force?: boolean) {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    if (!currentTrack && visibleTracks.length > 0) {
      setCurrentTrackId(visibleTracks[0].id);
      setCurrentTime(0);
      setIsPlaying(true);
      return;
    }

    const nextState = force ?? !isPlaying;
    setIsPlaying(nextState);

    if (nextState) {
      await audio.play().catch(() => {
        setStatusMessage('브라우저에서 재생을 허용한 뒤 다시 시도해 주세요.');
        setIsPlaying(false);
      });
      return;
    }

    audio.pause();
  }

  function getPlaybackPool(): TrackView[] {
    if (visibleTracks.length > 0) {
      return visibleTracks;
    }

    return tracks;
  }

  function playAdjacent(direction: 1 | -1) {
    const pool = getPlaybackPool();

    if (!pool.length) {
      return;
    }

    if (!currentTrackId) {
      setCurrentTrackId(pool[0].id);
      setCurrentTime(0);
      setIsPlaying(true);
      return;
    }

    if (shuffleEnabled) {
      const candidates = pool.filter((track) => track.id !== currentTrackId);
      const nextTrack = candidates[Math.floor(Math.random() * candidates.length)] ?? pool[0];
      setCurrentTrackId(nextTrack.id);
      setCurrentTime(0);
      setIsPlaying(true);
      return;
    }

    const currentIndex = pool.findIndex((track) => track.id === currentTrackId);
    const nextIndex = currentIndex + direction;

    if (nextIndex < 0) {
      const target = repeatMode === 'all' ? pool[pool.length - 1] : pool[0];
      setCurrentTrackId(target.id);
      setCurrentTime(0);
      setIsPlaying(repeatMode === 'all');
      return;
    }

    if (nextIndex >= pool.length) {
      if (repeatMode === 'all') {
        setCurrentTrackId(pool[0].id);
        setCurrentTime(0);
        setIsPlaying(true);
        return;
      }

      setIsPlaying(false);
      setCurrentTime(0);
      return;
    }

    setCurrentTrackId(pool[nextIndex].id);
    setCurrentTime(0);
    setIsPlaying(true);
  }

  function handleEnded() {
    if (repeatMode === 'one' && currentTrack) {
      setCurrentTime(0);
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
        void audioRef.current.play();
      }
      return;
    }

    playAdjacent(1);
  }

  async function handleCreateFolder() {
    const trimmed = newFolderName.trim();

    if (!trimmed) {
      return;
    }

    await saveFolder({
      id: createId('folder'),
      name: trimmed,
      createdAt: Date.now(),
    });
    setNewFolderName('');
    setStatusMessage(`폴더 "${trimmed}"를 만들었어요.`);
    await refreshLibrary();
  }

  async function handleDeleteTrack(trackId: string) {
    await deleteTrack(trackId);

    if (trackId === currentTrackId) {
      setCurrentTrackId(null);
      setCurrentTime(0);
      setIsPlaying(false);
    }

    setStatusMessage('트랙을 라이브러리에서 삭제했어요.');
    await refreshLibrary();
  }

  async function handleDeleteFolder(folderId: string) {
    const folder = folders.find((item) => item.id === folderId);
    await deleteFolder(folderId);

    if (currentFolderId === folderId) {
      setCurrentFolderId(ROOT_FOLDER_ID);
    }

    setStatusMessage(`폴더 "${folder?.name ?? ''}"를 정리하고 곡은 전체 라이브러리로 이동했어요.`);
    await refreshLibrary();
  }

  async function moveTrack(trackId: string, folderId: string) {
    const target = tracks.find((track) => track.id === trackId);
    if (!target) {
      return;
    }

    await saveTrack({ ...target, folderId, blob: target.blob });
    setStatusMessage('트랙 폴더를 변경했어요.');
    await refreshLibrary();
  }

  function cycleRepeatMode() {
    const currentIndex = repeatOrder.indexOf(repeatMode);
    setRepeatMode(repeatOrder[(currentIndex + 1) % repeatOrder.length]);
  }

  return (
    <main className="shell">
      <audio
        ref={audioRef}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          if (event.currentTarget.dataset.trackId === currentTrackId && currentTime > 0) {
            event.currentTarget.currentTime = currentTime;
          }
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={handleEnded}
      />

      <section className="hero card">
        <div>
          <span className="eyebrow">Serverless · Offline-first · PWA</span>
          <h1>Muser</h1>
          <p>
            여러 곡을 한 번에 업로드하고, 폴더로 정리하고, 네트워크가 끊겨도 재생되는 개인용
            뮤직 플레이어.
          </p>
        </div>
        <div className="heroActions">
          <button className="primaryButton" onClick={() => fileInputRef.current?.click()} disabled={isBusy}>
            {isBusy ? '저장 중...' : '음악 업로드'}
          </button>
          <button className="secondaryButton" onClick={() => void togglePlayback()} disabled={!tracks.length}>
            {isPlaying ? '일시정지' : '재생 시작'}
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="audio/*" multiple hidden onChange={handleUpload} />
      </section>

      <section className="statsGrid">
        <article className="card statCard">
          <span>저장된 곡</span>
          <strong>{storageStats.count}</strong>
        </article>
        <article className="card statCard">
          <span>사용 용량</span>
          <strong>{formatBytes(storageStats.totalBytes)}</strong>
        </article>
        <article className="card statCard">
          <span>현재 상태</span>
          <strong>{statusMessage}</strong>
        </article>
      </section>

      <section className="contentGrid">
        <aside className="card sidebar">
          <div className="sectionHeader">
            <div>
              <span className="eyebrow">Library</span>
              <h2>폴더 시스템</h2>
            </div>
          </div>

          <div className="folderCreateRow">
            <input
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              placeholder="새 폴더 이름"
            />
            <button className="secondaryButton" onClick={() => void handleCreateFolder()}>
              추가
            </button>
          </div>

          <div className="folderList">
            {folders.map((folder) => {
              const trackCount = tracks.filter((track) => folder.id === ROOT_FOLDER_ID || track.folderId === folder.id).length;
              return (
                <div
                  key={folder.id}
                  className={`folderItem ${currentFolderId === folder.id ? 'active' : ''}`}
                  onClick={() => setCurrentFolderId(folder.id)}
                >
                  <div>
                    <strong>{folder.name}</strong>
                    <span>{trackCount}곡</span>
                  </div>
                  {folder.id !== ROOT_FOLDER_ID ? (
                    <button
                      className="iconButton"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDeleteFolder(folder.id);
                      }}
                    >
                      삭제
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </aside>

        <section className="card playerPanel">
          <div className="sectionHeader">
            <div>
              <span className="eyebrow">Player</span>
              <h2>백그라운드 재생 컨트롤</h2>
            </div>
            <div className="controlGroup compact">
              <button className="secondaryButton" onClick={cycleRepeatMode}>
                반복: {repeatMode === 'off' ? '끔' : repeatMode === 'all' ? '전체' : '한 곡'}
              </button>
              <button className={`secondaryButton ${shuffleEnabled ? 'activeButton' : ''}`} onClick={() => setShuffleEnabled((value) => !value)}>
                셔플 {shuffleEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="nowPlaying">
            <div>
              <span className="eyebrow">Now Playing</span>
              <h3>{currentTrack?.name ?? '재생할 곡을 선택해 주세요'}</h3>
              <p>{currentTrack?.artist ?? '오프라인 라이브러리 준비 완료'}</p>
            </div>
            <div className="timelineMeta">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(currentTrack?.duration ?? 0)}</span>
            </div>
          </div>

          <input
            className="timeline"
            type="range"
            min={0}
            max={currentTrack?.duration || 0}
            step={1}
            value={Math.min(currentTime, currentTrack?.duration ?? 0)}
            onChange={(event) => {
              const nextTime = Number(event.target.value);
              setCurrentTime(nextTime);
              if (audioRef.current) {
                audioRef.current.currentTime = nextTime;
              }
            }}
            disabled={!currentTrack}
          />

          <div className="controlGroup">
            <button className="secondaryButton" onClick={() => playAdjacent(-1)} disabled={!tracks.length}>
              이전곡
            </button>
            <button className="primaryButton largeButton" onClick={() => void togglePlayback()} disabled={!tracks.length || !ready}>
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button className="secondaryButton" onClick={() => playAdjacent(1)} disabled={!tracks.length}>
              다음곡
            </button>
          </div>

          <div className="featureGrid">
            <div className="featureCard">
              <strong>오프라인 재생</strong>
              <p>Service Worker로 앱 셸을 캐시하고, 음악 파일은 IndexedDB에 저장합니다.</p>
            </div>
            <div className="featureCard">
              <strong>멀티 업로드</strong>
              <p>여러 개의 파일을 한 번에 넣고 현재 폴더 기준으로 정리할 수 있습니다.</p>
            </div>
            <div className="featureCard">
              <strong>백그라운드 컨트롤</strong>
              <p>Media Session API로 잠금화면/백그라운드에서 재생 제어를 지원합니다.</p>
            </div>
          </div>
        </section>
      </section>

      <section className="card playlistPanel">
        <div className="sectionHeader">
          <div>
            <span className="eyebrow">Playlist</span>
            <h2>{folders.find((folder) => folder.id === currentFolderId)?.name ?? '전체 라이브러리'}</h2>
          </div>
          <p>{visibleTracks.length}곡</p>
        </div>

        <div className="trackList">
          {visibleTracks.length ? (
            visibleTracks.map((track, index) => {
              const active = currentTrackId === track.id;
              return (
                <article key={track.id} className={`trackItem ${active ? 'active' : ''}`}>
                  <button
                    className="trackMain"
                    onClick={() => {
                      setCurrentTrackId(track.id);
                      setCurrentTime(0);
                      setIsPlaying(true);
                    }}
                  >
                    <span className="trackIndex">{String(index + 1).padStart(2, '0')}</span>
                    <div>
                      <strong>{track.name}</strong>
                      <p>
                        {track.artist} · {formatTime(track.duration)} · {formatBytes(track.size)}
                      </p>
                    </div>
                  </button>

                  <div className="trackActions">
                    <select value={track.folderId} onChange={(event) => void moveTrack(track.id, event.target.value)}>
                      {folders
                        .filter((folder) => folder.id === ROOT_FOLDER_ID || folder.id !== track.folderId)
                        .concat(folders.filter((folder) => folder.id === track.folderId))
                        .filter((folder, idx, array) => array.findIndex((item) => item.id === folder.id) === idx)
                        .map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folder.name}
                          </option>
                        ))}
                    </select>
                    <button className="iconButton" onClick={() => void handleDeleteTrack(track.id)}>
                      삭제
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <div className="emptyState">
              <h3>아직 곡이 없어요</h3>
              <p>오디오 파일을 여러 개 선택해서 이 브라우저에 바로 저장해 보세요.</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
