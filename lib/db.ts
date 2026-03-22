export type RepeatMode = 'off' | 'all' | 'one';

export type FolderRecord = {
  id: string;
  name: string;
  createdAt: number;
};

export type TrackRecord = {
  id: string;
  name: string;
  artist: string;
  fileType: string;
  size: number;
  duration: number;
  folderId: string;
  createdAt: number;
  blob: Blob;
};

const DB_NAME = 'muser-db';
const DB_VERSION = 1;
const TRACKS_STORE = 'tracks';
const FOLDERS_STORE = 'folders';
const SETTINGS_STORE = 'settings';

export const ROOT_FOLDER_ID = 'root';

export type PlayerSettings = {
  repeatMode: RepeatMode;
  shuffleEnabled: boolean;
  currentTrackId: string | null;
  currentTime: number;
  currentFolderId: string;
};

const defaultSettings: PlayerSettings = {
  repeatMode: 'off',
  shuffleEnabled: false,
  currentTrackId: null,
  currentTime: 0,
  currentFolderId: ROOT_FOLDER_ID,
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(TRACKS_STORE)) {
        const trackStore = db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
        trackStore.createIndex('folderId', 'folderId', { unique: false });
        trackStore.createIndex('createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(FOLDERS_STORE)) {
        db.createObjectStore(FOLDERS_STORE, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);

    handler(store)
      .then((value) => {
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error);
      })
      .catch(reject);
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function ensureDefaults(): Promise<void> {
  const folders = await getFolders();
  const hasRoot = folders.some((folder) => folder.id === ROOT_FOLDER_ID);

  if (!hasRoot) {
    await saveFolder({ id: ROOT_FOLDER_ID, name: '전체 라이브러리', createdAt: Date.now() });
  }
}

export async function getTracks(): Promise<TrackRecord[]> {
  return withStore(TRACKS_STORE, 'readonly', async (store) => {
    const result = await promisifyRequest(store.getAll() as IDBRequest<TrackRecord[]>);
    return result.sort((a, b) => b.createdAt - a.createdAt);
  });
}

export async function saveTrack(track: TrackRecord): Promise<void> {
  await withStore(TRACKS_STORE, 'readwrite', async (store) => {
    await promisifyRequest(store.put(track));
  });
}

export async function deleteTrack(trackId: string): Promise<void> {
  await withStore(TRACKS_STORE, 'readwrite', async (store) => {
    await promisifyRequest(store.delete(trackId));
  });
}

export async function getFolders(): Promise<FolderRecord[]> {
  return withStore(FOLDERS_STORE, 'readonly', async (store) => {
    const result = await promisifyRequest(store.getAll() as IDBRequest<FolderRecord[]>);
    return result.sort((a, b) => a.createdAt - b.createdAt);
  });
}

export async function saveFolder(folder: FolderRecord): Promise<void> {
  await withStore(FOLDERS_STORE, 'readwrite', async (store) => {
    await promisifyRequest(store.put(folder));
  });
}

export async function deleteFolder(folderId: string): Promise<void> {
  if (folderId === ROOT_FOLDER_ID) {
    return;
  }

  const tracks = await getTracks();
  const updates = tracks.filter((track) => track.folderId === folderId);

  await Promise.all(
    updates.map((track) =>
      saveTrack({
        ...track,
        folderId: ROOT_FOLDER_ID,
      }),
    ),
  );

  await withStore(FOLDERS_STORE, 'readwrite', async (store) => {
    await promisifyRequest(store.delete(folderId));
  });
}

export async function saveSettings(settings: PlayerSettings): Promise<void> {
  await withStore(SETTINGS_STORE, 'readwrite', async (store) => {
    await promisifyRequest(store.put({ key: 'player', value: settings }));
  });
}

export async function getSettings(): Promise<PlayerSettings> {
  return withStore(SETTINGS_STORE, 'readonly', async (store) => {
    const result = await promisifyRequest(store.get('player') as IDBRequest<{ key: string; value: PlayerSettings } | undefined>);
    return result?.value ?? defaultSettings;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '0:00';
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, '0');

  return `${minutes}:${seconds}`;
}
