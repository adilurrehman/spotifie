'use strict';

/**
 * Administrator management of the albums this machine keeps on disk.
 *
 * Creating an album folder, saving a cover, adding or removing a song,
 * updating songs.json: the operations that change what the library holds for
 * everyone using this installation. They are kept in their own module so that
 * a build of the user-facing application can be made by not including it -
 * there is then no route to reach, rather than a route that refuses.
 *
 * Every request handled here passes requireAdmin first, which verifies the
 * caller's Supabase session server-side and checks the verified user id
 * against the app_admins table. That is the authorization. A build without
 * this module is a separate matter, and neither substitutes for the other.
 */

const fs = require('fs');
const path = require('path');

const { requireAdmin } = require('./adminAuth');

/**
 * Build the album routes.
 *
 * The helpers come from the server rather than being written again here, so
 * an answer from this half looks exactly like an answer from the other.
 */
function createAdminAlbumRoutes(tools) {
    const sendJson = tools.sendJson;
    const jsonHeaders = tools.jsonHeaders;
    const SONGS_DIR = tools.songsDir;
    const SONGS_JSON = tools.songsJson;

    // Parse multipart form data (simple implementation)
    function parseMultipart(buffer, boundary) {
        const parts = {};
        const boundaryBuffer = Buffer.from('--' + boundary);
    
        let start = 0;
        let end = buffer.indexOf(boundaryBuffer, start);
    
        while (end !== -1) {
            start = end + boundaryBuffer.length;
            if (buffer.slice(start, start + 2).toString() === '--') break;
        
            start += 2; // Skip \r\n
            end = buffer.indexOf(boundaryBuffer, start);
            if (end === -1) break;
        
            const partData = buffer.slice(start, end - 2); // -2 for \r\n before boundary
            const headerEnd = partData.indexOf('\r\n\r\n');
        
            if (headerEnd !== -1) {
                const headers = partData.slice(0, headerEnd).toString();
                const content = partData.slice(headerEnd + 4);
            
                const nameMatch = headers.match(/name="([^"]+)"/);
                const filenameMatch = headers.match(/filename="([^"]+)"/);
                const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
            
                if (nameMatch) {
                    const name = nameMatch[1];
                    if (filenameMatch) {
                        parts[name] = {
                            filename: filenameMatch[1],
                            contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
                            data: content
                        };
                    } else {
                        parts[name] = content.toString();
                    }
                }
            }
        }
    
        return parts;
    }

    // Create album folder and save cover
    async function createAlbum(data) {
        const { title, artist, description, coverImage } = data;
    
        // Create folder name from title (sanitize)
        const folderName = title.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        const albumPath = path.join(SONGS_DIR, folderName);
    
        // Create folder if doesn't exist
        if (!fs.existsSync(albumPath)) {
            fs.mkdirSync(albumPath, { recursive: true });
        }
    
        // Save cover image if provided
        let coverPath = '';
        if (coverImage && coverImage.data) {
            const ext = coverImage.filename.split('.').pop() || 'jpg';
            const coverFilename = `cover.${ext}`;
            fs.writeFileSync(path.join(albumPath, coverFilename), coverImage.data);
            coverPath = `songs/${folderName}/${coverFilename}`;
        }
    
        // Create info.json
        const info = {
            title: title,
            description: description || artist || title,
            cover: coverPath || `songs/${folderName}/cover.jpg`
        };
        fs.writeFileSync(path.join(albumPath, 'info.json'), JSON.stringify(info, null, 2));
    
        // Update songs.json
        let songsJson = {};
        if (fs.existsSync(SONGS_JSON)) {
            songsJson = JSON.parse(fs.readFileSync(SONGS_JSON, 'utf8'));
        }
    
        const key = `songs/${folderName}`;
        songsJson[key] = {
            files: [],
            info: info
        };
    
        fs.writeFileSync(SONGS_JSON, JSON.stringify(songsJson, null, 2));
    
        return { success: true, path: key, folderName };
    }

    // Add song to album
    async function addSong(data) {
        const { albumPath, audioFile, title } = data;
    
        if (!albumPath || !audioFile || !audioFile.data) {
            throw new Error('Album path and audio file required');
        }
    
        const fullAlbumPath = path.join(__dirname, albumPath);
    
        if (!fs.existsSync(fullAlbumPath)) {
            throw new Error('Album folder does not exist');
        }
    
        // Get file extension from original filename
        const originalExt = path.extname(audioFile.filename) || '.mp3';
    
        // Use custom title if provided, otherwise use original filename
        let filename;
        if (title && title.trim()) {
            // Sanitize the title to create a safe filename
            const safeTitle = title.trim()
                .replace(/[<>:"/\\|?*]/g, '') // Remove invalid filename chars
                .replace(/\s+/g, '_');        // Replace spaces with underscores
            filename = safeTitle + originalExt;
        } else {
            filename = audioFile.filename;
        }
    
        // Save audio file with the new filename
        fs.writeFileSync(path.join(fullAlbumPath, filename), audioFile.data);
    
        // Update songs.json
        let songsJson = {};
        if (fs.existsSync(SONGS_JSON)) {
            songsJson = JSON.parse(fs.readFileSync(SONGS_JSON, 'utf8'));
        }
    
        if (songsJson[albumPath]) {
            if (!songsJson[albumPath].files.includes(filename)) {
                songsJson[albumPath].files.push(filename);
            }
        }
    
        fs.writeFileSync(SONGS_JSON, JSON.stringify(songsJson, null, 2));
    
        return { success: true, filename };
    }

    // Delete album
    async function deleteAlbum(albumPath) {
        const fullPath = path.join(__dirname, albumPath);
    
        if (fs.existsSync(fullPath)) {
            fs.rmSync(fullPath, { recursive: true, force: true });
        }
    
        // Update songs.json
        let songsJson = {};
        if (fs.existsSync(SONGS_JSON)) {
            songsJson = JSON.parse(fs.readFileSync(SONGS_JSON, 'utf8'));
        }
    
        delete songsJson[albumPath];
        fs.writeFileSync(SONGS_JSON, JSON.stringify(songsJson, null, 2));
    
        return { success: true };
    }

    // Delete song from album
    async function deleteSong(albumPath, filename) {
        const fullAlbumPath = path.join(__dirname, albumPath);
        const songPath = path.join(fullAlbumPath, filename);
    
        if (fs.existsSync(songPath)) {
            fs.unlinkSync(songPath);
        } else {
            throw new Error('Song file not found');
        }
    
        // Update songs.json
        let songsJson = {};
        if (fs.existsSync(SONGS_JSON)) {
            songsJson = JSON.parse(fs.readFileSync(SONGS_JSON, 'utf8'));
        }
    
        if (songsJson[albumPath] && songsJson[albumPath].files) {
            songsJson[albumPath].files = songsJson[albumPath].files.filter(f => f !== filename);
            fs.writeFileSync(SONGS_JSON, JSON.stringify(songsJson, null, 2));
        }
    
        return { success: true, filename };
    }

    // Update existing album
    async function updateAlbum(data) {
        const { folderPath, title, artist, description, coverImage } = data;
    
        const fullPath = path.join(__dirname, folderPath);
    
        if (!fs.existsSync(fullPath)) {
            throw new Error('Album folder does not exist');
        }
    
        // Save new cover image if provided
        if (coverImage && coverImage.data) {
            const ext = coverImage.filename.split('.').pop() || 'jpg';
            const coverFilename = `cover.${ext}`;
            fs.writeFileSync(path.join(fullPath, coverFilename), coverImage.data);
        }
    
        // Update info.json
        const infoPath = path.join(fullPath, 'info.json');
        let info = {};
    
        if (fs.existsSync(infoPath)) {
            info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        }
    
        info.title = title || info.title;
        info.description = description || artist || info.description;
    
        fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
    
        // Update songs.json
        let songsJson = {};
        if (fs.existsSync(SONGS_JSON)) {
            songsJson = JSON.parse(fs.readFileSync(SONGS_JSON, 'utf8'));
        }
    
        if (songsJson[folderPath]) {
            songsJson[folderPath].info = info;
            fs.writeFileSync(SONGS_JSON, JSON.stringify(songsJson, null, 2));
        }
    
        return { success: true, path: folderPath };
    }


    /**
     * Answer true when this request was one of these routes, false when it was
     * not. False means the server carries on and eventually answers 404, the
     * same as for any unknown path.
     */
    async function handle(req, res, parsedUrl) {
        const pathname = parsedUrl.pathname;

        const routes = [
            '/api/create-album',
            '/api/add-song',
            '/api/delete-album',
            '/api/delete-song',
            '/api/update-album'
        ];
        if (routes.indexOf(pathname) === -1) return false;
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return true;
        }

        // Server-side, before anything is read from the body: a hidden button
        // is not authorization, and neither is anything the browser sends.
        const adminCheck = await requireAdmin(req);
        if (!adminCheck.ok) {
            sendJson(res, adminCheck.status, { error: adminCheck.error });
            return true;
        }

            // API routes
            if (parsedUrl.pathname === '/api/create-album' && req.method === 'POST') {
                let body = [];
        
                req.on('data', chunk => body.push(chunk));
                req.on('end', async () => {
                    try {
                        const buffer = Buffer.concat(body);
                        const contentType = req.headers['content-type'] || '';
                
                        let data;
                        if (contentType.includes('multipart/form-data')) {
                            const boundary = contentType.split('boundary=')[1];
                            data = parseMultipart(buffer, boundary);
                        } else {
                            data = JSON.parse(buffer.toString());
                        }
                
                        const result = await createAlbum(data);
                
                        res.writeHead(200, jsonHeaders);
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        console.error('Create album error:', err);
                        res.writeHead(500, jsonHeaders);
                        res.end(JSON.stringify({ error: err.message }));
                    }
                });
                return true;
            }
    
            if (parsedUrl.pathname === '/api/add-song' && req.method === 'POST') {
                let body = [];
        
                req.on('data', chunk => body.push(chunk));
                req.on('end', async () => {
                    try {
                        const buffer = Buffer.concat(body);
                        const contentType = req.headers['content-type'] || '';
                
                        let data;
                        if (contentType.includes('multipart/form-data')) {
                            const boundary = contentType.split('boundary=')[1];
                            data = parseMultipart(buffer, boundary);
                        } else {
                            data = JSON.parse(buffer.toString());
                        }
                
                        const result = await addSong(data);
                
                        res.writeHead(200, jsonHeaders);
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        console.error('Add song error:', err);
                        res.writeHead(500, jsonHeaders);
                        res.end(JSON.stringify({ error: err.message }));
                    }
                });
                return true;
            }
    
            if (parsedUrl.pathname === '/api/delete-album' && req.method === 'POST') {
                let body = '';
        
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const { albumPath } = JSON.parse(body);
                        const result = await deleteAlbum(albumPath);
                
                        res.writeHead(200, jsonHeaders);
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        console.error('Delete album error:', err);
                        res.writeHead(500, jsonHeaders);
                        res.end(JSON.stringify({ error: err.message }));
                    }
                });
                return true;
            }
    
            if (parsedUrl.pathname === '/api/delete-song' && req.method === 'POST') {
                let body = '';
        
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const { albumPath, filename } = JSON.parse(body);
                        const result = await deleteSong(albumPath, filename);
                
                        res.writeHead(200, jsonHeaders);
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        console.error('Delete song error:', err);
                        res.writeHead(500, jsonHeaders);
                        res.end(JSON.stringify({ error: err.message }));
                    }
                });
                return true;
            }
    
            if (parsedUrl.pathname === '/api/update-album' && req.method === 'POST') {
                let body = [];
        
                req.on('data', chunk => body.push(chunk));
                req.on('end', async () => {
                    try {
                        const buffer = Buffer.concat(body);
                        const contentType = req.headers['content-type'] || '';
                
                        let data;
                        if (contentType.includes('multipart/form-data')) {
                            const boundary = contentType.split('boundary=')[1];
                            data = parseMultipart(buffer, boundary);
                        } else {
                            data = JSON.parse(buffer.toString());
                        }
                
                        const result = await updateAlbum(data);
                
                        res.writeHead(200, jsonHeaders);
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        console.error('Update album error:', err);
                        res.writeHead(500, jsonHeaders);
                        res.end(JSON.stringify({ error: err.message }));
                    }
                });
                return true;
            }

        sendJson(res, 404, { error: 'Not found' });
        return true;
    }

    return { handle: handle };
}

module.exports = { createAdminAlbumRoutes };
