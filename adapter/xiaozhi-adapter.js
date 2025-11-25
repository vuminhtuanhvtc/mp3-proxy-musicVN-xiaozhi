/**
 * Xiaozhi Adapter - TƯƠNG THÍCH 100% VỚI CODE ESP32 C++
 * SỬA ĐỔI: Hỗ trợ biến môi trường PUBLIC_URL cho DDNS/Domain
 * CẬP NHẬT: Mapping key giống hệt server gốc (cover_url, audio_full_url...)
 */

const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5006;
// URL của Backend ZMP3 (Container mp3-api)
const MP3_API_URL = process.env.MP3_API_URL || 'http://mp3-api:5555';
// URL Public (DDNS/Domain) nếu có. VD: http://my-domain.com:5006
const PUBLIC_URL = process.env.PUBLIC_URL;

// CACHE ĐƠN GIẢN
const audioCache = new Map(); // {songId: Buffer}
const CACHE_MAX_SIZE = 10;

app.get('/stream_pcm', async (req, res) => {
    try {
        const { song, artist = '' } = req.query;

        if (!song) {
            return res.status(400).json({ error: 'Missing song parameter' });
        }

        console.log(`🔍 Searching: "${song}" by "${artist}"`);

        const searchQuery = artist ? `${song} ${artist}` : song;
        const searchUrl = `${MP3_API_URL}/api/search?q=${encodeURIComponent(searchQuery)}`;
        
        const searchResponse = await axios.get(searchUrl, {
            timeout: 15000,
            headers: { 'User-Agent': 'Xiaozhi-Adapter/1.0' }
        });

        let songs = [];
        if (searchResponse.data.err === 0 && 
            searchResponse.data.data && 
            Array.isArray(searchResponse.data.data.songs)) {
            songs = searchResponse.data.data.songs;
        }

        if (songs.length === 0) {
            return res.status(404).json({
                error: 'Song not found',
                title: song,
                artist: artist || 'Unknown'
            });
        }

        // Lấy bài đầu tiên
        const topSongs = songs.slice(0, 1);
        console.log(`✅ Found ${topSongs.length} songs`);

        // ===== XÁC ĐỊNH BASE URL (ƯU TIÊN PUBLIC_URL) =====
        let baseUrl;
        if (PUBLIC_URL) {
            // Nếu có cấu hình PUBLIC_URL trong docker-compose, dùng nó
            // Xóa dấu / ở cuối nếu người dùng lỡ tay thêm vào
            baseUrl = PUBLIC_URL.replace(/\/$/, '');
            console.log(`🌐 Using Configured Public URL: ${baseUrl}`);
        } else {
            // Fallback: Tự động phát hiện IP nội bộ
            const protocol = 'http'; 
            const host = req.headers.host; 
            baseUrl = `${protocol}://${host}`;
            console.log(`🏠 Using Auto-detected Local URL: ${baseUrl}`);
        }

        // ===== PRE-DOWNLOAD AUDIO =====
        const results = [];
        for (const songItem of topSongs) {
            const songId = songItem.encodeId;
            
            if (!songId) {
                console.log(`⚠️ Skipping song without ID: ${songItem.title}`);
                continue;
            }
            
            console.log(`🎵 Processing: ${songItem.title} (ID: ${songId})`);

            // Pre-download nếu chưa có trong cache
            let fromCache = false;
            if (!audioCache.has(songId)) {
                console.log(`⬇️ Pre-downloading audio for ${songId}...`);
                try {
                    const streamUrl = `${MP3_API_URL}/api/song/stream?id=${songId}`;
                    const audioResponse = await axios({
                        method: 'GET',
                        url: streamUrl,
                        responseType: 'arraybuffer',
                        maxRedirects: 5,
                        timeout: 120000,
                        headers: { 'User-Agent': 'Xiaozhi-Adapter/1.0' }
                    });

                    const audioBuffer = Buffer.from(audioResponse.data);
                    console.log(`✅ Downloaded ${audioBuffer.length} bytes`);

                    // Lưu vào cache
                    audioCache.set(songId, audioBuffer);
                    if (audioCache.size > CACHE_MAX_SIZE) {
                        const firstKey = audioCache.keys().next().value;
                        audioCache.delete(firstKey);
                    }
                } catch (error) {
                    console.error(`❌ Failed to pre-download ${songId}: ${error.message}`);
                    continue;
                }
            } else {
                fromCache = true;
                console.log(`✅ Using cached audio for ${songId}`);
            }

            // ===== QUAN TRỌNG: MAPPING GIỐNG HỆT SERVER TRUNG QUỐC =====
            const audioLink = `${baseUrl}/proxy_audio?id=${songId}`;
            results.push({
                title: songItem.title || song,
                artist: songItem.artistsNames || artist || 'Unknown',
                
                // Link chính
                audio_url: audioLink,
                
                // Link phụ (Fake cho giống mẫu, trỏ về cùng 1 file)
                audio_full_url: audioLink,
                m3u8_url: audioLink, // ESP32 này không dùng m3u8 nhưng để vào cho đủ bộ
                
                lyric_url: `${baseUrl}/proxy_lyric?id=${songId}`,
                
                // Đổi 'thumbnail' thành 'cover_url' để khớp với server gốc
                cover_url: songItem.thumbnail || songItem.thumbnailM || '',
                
                duration: songItem.duration || 0,
                
                // Metadata giả lập
                from_cache: fromCache,
                // Trả về IP/Domain từ baseUrl để giống format gốc
                ip: baseUrl.replace('http://', '').replace('https://', '').split(':')[0]
            });
        }

        if (results.length === 0) {
            return res.status(500).json({ error: 'Failed to process any songs' });
        }

        const response = results[0];
        console.log(`✅ Returning song (BaseURL: ${baseUrl})`);
        res.json(response);

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ... (Các phần còn lại giữ nguyên) ...

// ===== PROXY AUDIO TỪ CACHE =====
app.get('/proxy_audio', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) {
            return res.status(400).send('Missing id parameter');
        }

        // Lấy từ cache
        if (audioCache.has(id)) {
            const audioBuffer = audioCache.get(id);
            res.set({
                'Content-Type': 'audio/mpeg',
                'Content-Length': audioBuffer.length,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=86400'
            });
            res.send(audioBuffer);
        } else {
            // Fallback download
            const streamUrl = `${MP3_API_URL}/api/song/stream?id=${id}`;
            const audioResponse = await axios({
                method: 'GET',
                url: streamUrl,
                responseType: 'arraybuffer',
                timeout: 120000
            });
            const audioBuffer = Buffer.from(audioResponse.data);
            audioCache.set(id, audioBuffer);
            res.set({
                'Content-Type': 'audio/mpeg',
                'Content-Length': audioBuffer.length,
                'Accept-Ranges': 'bytes'
            });
            res.send(audioBuffer);
        }
    } catch (error) {
        console.error('❌ Proxy audio error:', error.message);
        res.status(500).send('Failed to proxy audio');
    }
});

// ===== PROXY LYRIC =====
app.get('/proxy_lyric', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) {
            return res.status(400).send('Missing id parameter');
        }

        const lyricUrl = `${MP3_API_URL}/api/lyric?id=${id}`;
        const response = await axios.get(lyricUrl, { timeout: 10000 });

        if (response.data && response.data.err === 0 && response.data.data) {
            const lyricData = response.data.data;
            if (lyricData.file) {
                const lyricContent = await axios.get(lyricData.file);
                res.set('Content-Type', 'text/plain; charset=utf-8');
                res.send(lyricContent.data);
            } else if (Array.isArray(lyricData.sentences)) {
                let lrcContent = '';
                lyricData.sentences.forEach(s => {
                    const words = s.words || [];
                    words.forEach(w => {
                        const time = w.startTime || 0;
                        const minutes = Math.floor(time / 60000);
                        const seconds = Math.floor((time % 60000) / 1000);
                        const ms = Math.floor((time % 1000) / 10);
                        lrcContent += `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(2, '0')}]${w.data}\n`;
                    });
                });
                res.set('Content-Type', 'text/plain; charset=utf-8');
                res.send(lrcContent);
            } else {
                res.status(404).send('Lyric not found');
            }
        } else {
            res.status(404).send('Lyric not found');
        }
    } catch (error) {
        res.status(404).send('Lyric not found');
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        cache_size: audioCache.size,
        cached_songs: Array.from(audioCache.keys())
    });
});

app.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log(`🎵 Xiaozhi Adapter (PUBLIC URL SUPPORT) on port ${PORT}`);
    console.log(`🔗 MP3 API: ${MP3_API_URL}`);
    if (PUBLIC_URL) {
        console.log(`🌍 PUBLIC_URL set: ${PUBLIC_URL}`);
    } else {
        console.log(`🏠 No PUBLIC_URL set, using auto-detection`);
    }
    console.log('='.repeat(60));
});
