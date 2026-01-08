const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const port = 3000;
const uploadsDir = path.join(__dirname, 'uploads');
const TEN_MEGABYTES = 10 * 1024 * 1024;
const tagsFilePath = path.join(__dirname, 'tags.json');
const cotdFilePath = path.join(__dirname, 'cotd.json');
const durationsFilePath = path.join(__dirname, 'durations.json'); // NEW: Persistence file

// --- CACHE STATE ---
let TAGS_CACHE = { allTags: [], clipTags: {} };
let DURATIONS_CACHE = {}; // NEW: Cache for video lengths
let USERS_CACHE = [];
let ALL_CLIPS_CACHE = []; 

// --- DEBOUNCE STATE ---
let saveTagsTimeout = null;

app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.static('public', { maxAge: '1d' }));
app.use('/uploads', express.static(uploadsDir, { maxAge: '1d' }));

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// --- INITIALIZATION ---
function initializeServer() {
    console.log("Initializing server and building cache...");
    
    // Load Tags
    if (fs.existsSync(tagsFilePath)) {
        try { TAGS_CACHE = JSON.parse(fs.readFileSync(tagsFilePath)); } 
        catch (e) { console.error("Error reading tags, resetting."); }
    } else {
        fs.writeFileSync(tagsFilePath, JSON.stringify(TAGS_CACHE));
    }

    // NEW: Load Durations
    if (fs.existsSync(durationsFilePath)) {
        try { DURATIONS_CACHE = JSON.parse(fs.readFileSync(durationsFilePath)); }
        catch (e) { console.error("Error reading durations, resetting."); }
    }

    refreshFileCache();
}

// --- HELPER FUNCTIONS ---

async function refreshFileCache() {
    if (!fs.existsSync(uploadsDir)) return;
    try {
        const userDirents = await fs.promises.readdir(uploadsDir, { withFileTypes: true });
        const users = userDirents.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
        const pfpFilenames = ['pfp.png', 'pfp.jpg', 'pfp.jpeg', 'pfp.gif', 'avatar.png', 'avatar.jpg'];
        
        const newUsersCache = [];
        const newAllClipsCache = [];
        let durationsChanged = false;

        // We will build a clean durations object to remove orphans (deleted files)
        const activeDurations = {}; 

        for (const user of users) {
            const userDir = path.join(uploadsDir, user);
            let profilePicture = null;
            for (const pfp of pfpFilenames) {
                if (fs.existsSync(path.join(userDir, pfp))) {
                    profilePicture = `/uploads/${user}/${pfp}`;
                    break;
                }
            }
            newUsersCache.push({ name: user, profilePicture });

            const files = await fs.promises.readdir(userDir);
            const relevantFiles = files.filter(file => file.endsWith('-compressed.mp4'));
            
            for (const file of relevantFiles) {
                const thumbnailFilename = `${file}.jpg`;
                const thumbnailExists = files.includes(thumbnailFilename);
                const title = file.replace(/^\d{13}-/, '').replace(/-compressed\.mp4$/, '');
                const clipId = `${user}/${file}`;
                
                // NEW: Check cache for duration, otherwise calculate it
                let duration = DURATIONS_CACHE[clipId];
                if (duration === undefined) {
                    console.log(`Calculating duration for new clip: ${file}`);
                    duration = await getVideoDuration(path.join(userDir, file));
                    durationsChanged = true;
                }
                activeDurations[clipId] = duration;

                let mtimeMs = Date.now();
                try {
                    const stats = fs.statSync(path.join(userDir, file));
                    mtimeMs = stats.mtimeMs;
                } catch (e) {}

                newAllClipsCache.push({
                    user: user,
                    filename: file,
                    uniqueId: clipId,
                    thumbnail: thumbnailExists ? thumbnailFilename : null,
                    title: title,
                    createdAt: mtimeMs,
                    tags: TAGS_CACHE.clipTags[clipId] || [],
                    duration: duration // NEW: Add duration to cache object
                });
            }
        }

        USERS_CACHE = newUsersCache.sort((a, b) => a.name.localeCompare(b.name));
        ALL_CLIPS_CACHE = newAllClipsCache;
        DURATIONS_CACHE = activeDurations; // Replace old cache with clean one

        if (durationsChanged) {
            fs.writeFileSync(durationsFilePath, JSON.stringify(DURATIONS_CACHE, null, 2));
            console.log("Updated durations.json");
        }

        console.log(`Cache refreshed: ${USERS_CACHE.length} users, ${ALL_CLIPS_CACHE.length} clips.`);
    } catch (error) {
        console.error("Error refreshing cache:", error);
    }
}

async function saveTags() {
    if (saveTagsTimeout) clearTimeout(saveTagsTimeout);
    saveTagsTimeout = setTimeout(async () => {
        try {
            console.log("Saving tags to disk...");
            await fs.promises.writeFile(tagsFilePath, JSON.stringify(TAGS_CACHE, null, 2));
        } catch (err) {
            console.error("Error saving tags:", err);
        }
    }, 5000); 
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-chunk-' + file.originalname)
});

const fileFilter = (req, file, cb) => {
    const filetypes = /mkv|mov|mp4/;
    if (filetypes.test(path.extname(file.originalname).toLowerCase())) {
        cb(null, true);
    } else {
        cb(new Error('Only .mp4, .mkv, or .mov files allowed!'));
    }
};

const upload = multer({ storage: storage, fileFilter: fileFilter });

function getVideoDuration(filePath) {
    return new Promise((resolve) => {
        const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
        exec(command, (error, stdout) => {
            if (error) return resolve(0);
            resolve(parseFloat(stdout) || 0);
        });
    });
}

function generateThumbnail(videoPath) {
    return new Promise((resolve, reject) => {
        const thumbnailPath = `${videoPath}.jpg`;
        const command = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf scale=480:-1 -y "${thumbnailPath}"`;
        exec(command, (error) => {
            if (error) return reject(error);
            resolve(thumbnailPath);
        });
    });
}

function getClipOfTheDay() {
    const today = new Date().toISOString().slice(0, 10);
    let data = { currentClip: null, usedClips: [] };
    if (fs.existsSync(cotdFilePath)) { try { data = JSON.parse(fs.readFileSync(cotdFilePath)); } catch {} }

    if (data.currentClip && data.currentClip.chosenDate === today) return data.currentClip;
    if (ALL_CLIPS_CACHE.length === 0) return null;
    
    let potentialClips = ALL_CLIPS_CACHE.filter(clip => !data.usedClips.includes(clip.uniqueId));
    if (potentialClips.length === 0) { data.usedClips = []; potentialClips = ALL_CLIPS_CACHE; }
    
    const newClip = potentialClips[Math.floor(Math.random() * potentialClips.length)];
    data.currentClip = { ...newClip, chosenDate: today };
    data.usedClips.push(newClip.uniqueId);
    
    fs.writeFileSync(cotdFilePath, JSON.stringify(data, null, 2));
    return data.currentClip;
}

// This handles the FFmpeg logic after the file is fully assembled
function processUploadedFile(tempPath, originalFilename, userDir) {
    return new Promise((resolve, reject) => {
        const safeName = path.basename(originalFilename);
        const timestamp = Date.now();
        const outName = `${timestamp}-${path.parse(safeName).name}-compressed.mp4`;
        const outPath = path.join(userDir, outName);

        const finish = () => {
            if (tempPath !== outPath && fs.existsSync(tempPath)) {
                fs.unlink(tempPath, () => {});
            }
            generateThumbnail(outPath).then(resolve).catch(reject);
        };

        // FFmpeg Logic
        const cmd = `ffmpeg -i "${tempPath}" -y -pix_fmt yuv420p -c:v libx264 -preset ultrafast -crf 26 -maxrate 8M -bufsize 16M -c:a aac -b:a 128k -movflags +faststart "${outPath}"`;
        
        // Simple check: if file is huge, re-encode. If small/mp4, try copy (optional optimization)
        // For robustness with chunked uploads, we'll just run the re-encode command.
        // It guarantees the output is a clean, valid MP4 web-ready file.
        exec(cmd, (err) => {
             if (err) return reject(err);
             finish();
        });
    });
}

// --- API ROUTES ---

app.get('/api/tags', (req, res) => res.json(TAGS_CACHE));

app.post('/api/tags/create', async (req, res) => {
    const { newTag } = req.body;
    if (!newTag || typeof newTag !== 'string' || newTag.trim().length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid tag.' });
    }
    const sanitizedTag = newTag.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    
    if (TAGS_CACHE.allTags.includes(sanitizedTag)) return res.status(409).json({ success: false, message: 'Exists.' });

    TAGS_CACHE.allTags.push(sanitizedTag);
    TAGS_CACHE.allTags.sort();
    await saveTags(); 

    res.json({ success: true, allTags: TAGS_CACHE.allTags });
});

app.post('/api/tags/update', async (req, res) => {
    const { user, filename, tag, isAdding } = req.body;
    const clipId = `${user}/${filename}`;

    if (!TAGS_CACHE.clipTags[clipId]) TAGS_CACHE.clipTags[clipId] = [];
    const tagIndex = TAGS_CACHE.clipTags[clipId].indexOf(tag);

    if (isAdding) {
        if (tagIndex === -1) TAGS_CACHE.clipTags[clipId].push(tag);
    } else {
        if (tagIndex > -1) TAGS_CACHE.clipTags[clipId].splice(tagIndex, 1);
    }

    await saveTags();
    
    const cachedClip = ALL_CLIPS_CACHE.find(c => c.uniqueId === clipId);
    if (cachedClip) cachedClip.tags = TAGS_CACHE.clipTags[clipId];

    res.json({ success: true, updatedTags: TAGS_CACHE.clipTags[clipId] });
});

app.post('/api/tags/delete', async (req, res) => {
    const { tag } = req.body;
    if (!tag) return res.status(400).json({ success: false, message: 'No tag provided.' });

    const tagIndex = TAGS_CACHE.allTags.indexOf(tag);
    if (tagIndex > -1) {
        // 1. Remove from master list
        TAGS_CACHE.allTags.splice(tagIndex, 1);

        // 2. Remove from ALL clips that have this tag
        Object.keys(TAGS_CACHE.clipTags).forEach(clipId => {
            const tIdx = TAGS_CACHE.clipTags[clipId].indexOf(tag);
            if (tIdx > -1) {
                TAGS_CACHE.clipTags[clipId].splice(tIdx, 1);
                // Update the main cache object too
                const cachedClip = ALL_CLIPS_CACHE.find(c => c.uniqueId === clipId);
                if (cachedClip) cachedClip.tags = TAGS_CACHE.clipTags[clipId];
            }
        });

        await saveTags();
        res.json({ success: true, allTags: TAGS_CACHE.allTags });
    } else {
        res.json({ success: false, message: 'Tag not found.' });
    }
});

app.get('/api/all-clips', (req, res) => res.json(ALL_CLIPS_CACHE));

app.get('/search', (req, res) => {
    const query = (req.query.q || '').toLowerCase();
    if (!query) return res.json([]);
    const matchingClips = ALL_CLIPS_CACHE.filter(clip => 
        clip.title.toLowerCase().includes(query) || 
        clip.user.toLowerCase().includes(query) ||
        (clip.tags && clip.tags.some(tag => tag.includes(query)))
    );
    res.json(matchingClips);
});

app.get('/', (req, res) => {
    const sortedClips = [...ALL_CLIPS_CACHE].sort((a, b) => b.createdAt - a.createdAt);
    const recentClips = sortedClips.slice(0, 4);

    res.render('index', { 
        allUsers: USERS_CACHE, 
        clipOfTheDay: getClipOfTheDay(),
        recentClips: recentClips 
    });
});

app.get('/:user', async (req, res) => {
    try {
        const userName = req.params.user;
        const userExists = USERS_CACHE.some(u => u.name === userName);
        if (!userExists) return res.status(404).send("User not found.");

        const userClips = ALL_CLIPS_CACHE.filter(c => c.user === userName);
        const userDir = path.join(uploadsDir, userName);
        
        let pinnedFilenames = [];
        try { pinnedFilenames = JSON.parse(fs.readFileSync(path.join(userDir, 'pinned.json'))); } catch {}

        // OPTIMIZED: Use cached durations instead of calculating on request
        const totalSeconds = userClips.reduce((sum, clip) => sum + (clip.duration || 0), 0);

        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);
        let totalDurationString = hours > 0 
            ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
            : `${minutes}:${seconds.toString().padStart(2, '0')}`;

        res.render('profile', {
            userName: userName,
            clips: userClips.filter(c => !pinnedFilenames.includes(c.filename)),
            pinnedClips: userClips.filter(c => pinnedFilenames.includes(c.filename)),
            stats: { clipCount: userClips.length, totalDuration: totalDurationString },
            allUsers: USERS_CACHE,
            allTags: TAGS_CACHE.allTags
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading page.");
    }
});

app.post('/pin', (req, res) => {
    const { user, filename, pin } = req.body;
    const safeUser = user.replace(/[^a-zA-Z0-9]/g, '');
    const pinnedPath = path.join(uploadsDir, safeUser, 'pinned.json');
    let pinned = [];
    try { pinned = JSON.parse(fs.readFileSync(pinnedPath)); } catch {}

    if (pin) { if (!pinned.includes(filename)) pinned.push(filename); }
    else { pinned = pinned.filter(f => f !== filename); }

    fs.writeFileSync(pinnedPath, JSON.stringify(pinned, null, 2));
    res.json({ success: true });
});

app.post('/rename', async (req, res) => {
    const { user, oldFilename, newTitle } = req.body;
    const safeUser = user.replace(/[^a-zA-Z0-9]/g, '');
    const safeOld = path.basename(oldFilename);
    const safeTitle = newTitle.replace(/[\\/:*?"<>|]/g, '').trim();

    // If the file has a timestamp, keep it. If not (from the recent bug), generate a new one.
    let timestampPrefix = '';
    const tsMatch = safeOld.match(/^\d{13}-/);
    
    if (tsMatch) {
        timestampPrefix = tsMatch[0];
    } else {
        // The file is missing a timestamp, so we create one now to "fix" it.
        timestampPrefix = Date.now() + '-';
    }
    
    const newFilename = `${timestampPrefix}${safeTitle}-compressed.mp4`;
    const oldP = path.join(uploadsDir, safeUser, safeOld);
    const newP = path.join(uploadsDir, safeUser, newFilename);

    const oldId = `${safeUser}/${safeOld}`;
    const newId = `${safeUser}/${newFilename}`;
    
    // Update Tags
    if (TAGS_CACHE.clipTags[oldId]) {
        TAGS_CACHE.clipTags[newId] = TAGS_CACHE.clipTags[oldId];
        delete TAGS_CACHE.clipTags[oldId];
        await saveTags();
    }

    // Update Durations immediately
    if (DURATIONS_CACHE[oldId]) {
        DURATIONS_CACHE[newId] = DURATIONS_CACHE[oldId];
    }

    const pinP = path.join(uploadsDir, safeUser, 'pinned.json');
    try {
        let pins = JSON.parse(fs.readFileSync(pinP));
        const idx = pins.indexOf(safeOld);
        if (idx > -1) {
            pins[idx] = newFilename;
            fs.writeFileSync(pinP, JSON.stringify(pins, null, 2));
        }
    } catch {}

    fs.rename(oldP, newP, (err) => {
        if (err) {
            console.error("Rename failed:", err);
            return res.status(500).json({ success: false });
        }
        if (fs.existsSync(oldP + '.jpg')) fs.rename(oldP + '.jpg', newP + '.jpg', () => {});
        refreshFileCache();
        res.json({ success: true, newFilename: newFilename, newTitle: safeTitle });
    });
});

app.post('/upload-chunk', upload.single('chunk'), async (req, res) => {
    try {
        const { userName, fileId, fileName, chunkIndex, totalChunks } = req.body;
        
        // Security: sanitize inputs
        const safeUserName = userName.replace(/[^a-zA-Z0-9]/g, '') || 'guest';
        const safeFileName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '');
        const currentChunk = parseInt(chunkIndex);
        const total = parseInt(totalChunks);

        const userDir = path.join(uploadsDir, safeUserName);
        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir);

        // We assemble the file in a "temp" folder inside the user's dir
        const tempDir = path.join(userDir, 'temp_chunks');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        const tempFilePath = path.join(tempDir, `${fileId}-${safeFileName}`);

        // If it's the first chunk, start a new file. Otherwise, append.
        // NOTE: The client sends chunks sequentially (await), so appendFileSync is safe here.
        if (currentChunk === 0) {
            fs.writeFileSync(tempFilePath, fs.readFileSync(req.file.path));
        } else {
            fs.appendFileSync(tempFilePath, fs.readFileSync(req.file.path));
        }

        // Clean up the tiny chunk file Multer created in /uploads
        fs.unlinkSync(req.file.path);

        // Check if this was the last chunk
        if (currentChunk === total - 1) {
            // File assembly complete. Now process it.
            console.log(`Assembly complete for ${safeFileName}. Processing...`);
            
            try {
                await processUploadedFile(tempFilePath, safeFileName, userDir);
                refreshFileCache(); // Update the website
                
                // Cleanup the temp assembly file if processUploadedFile didn't already
                if (fs.existsSync(tempFilePath)) fs.unlink(tempFilePath, () => {});
                
                res.json({ success: true, message: 'Upload and processing complete.' });
            } catch (err) {
                console.error("Processing error:", err);
                res.status(500).json({ success: false, message: 'Processing failed.' });
            }
        } else {
            // Just a chunk, not done yet
            res.json({ success: true, message: 'Chunk received' });
        }

    } catch (error) {
        console.error("Chunk Error:", error);
        res.status(500).json({ success: false, message: 'Server error handling chunk.' });
    }
});

app.delete('/delete', (req, res) => {
    const { user, file } = req.body;
    const safeUser = user.replace(/[^a-zA-Z0-9]/g, '');
    const safeFile = path.basename(file);
    const filePath = path.join(uploadsDir, safeUser, safeFile);
    
    const clipId = `${safeUser}/${safeFile}`;
    if (TAGS_CACHE.clipTags[clipId]) {
        delete TAGS_CACHE.clipTags[clipId];
        saveTags(); 
    }

    const pinP = path.join(uploadsDir, safeUser, 'pinned.json');
    try {
        let pins = JSON.parse(fs.readFileSync(pinP));
        const newPins = pins.filter(f => f !== safeFile);
        if (newPins.length !== pins.length) fs.writeFileSync(pinP, JSON.stringify(newPins, null, 2));
    } catch {}

    fs.unlink(filePath, (err) => {
        if (err) return res.status(404).json({ success: false });
        if (fs.existsSync(filePath + '.jpg')) fs.unlink(filePath + '.jpg', () => {});
        refreshFileCache();
        res.json({ success: true });
    });
});

initializeServer();
const server = app.listen(port, () => console.log(`Server running: http://localhost:${port}`));

// Increase timeout to 10 minutes to handle large uploads
server.timeout = 600000; 
server.keepAliveTimeout = 600000;