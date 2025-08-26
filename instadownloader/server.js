// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper function to extract shortcode from Instagram URL
function extractShortcode(url) {
    const patterns = [
        /instagram\.com\/p\/([^/?#]+)/,
        /instagram\.com\/reel\/([^/?#]+)/,
        /instagram\.com\/tv\/([^/?#]+)/,
        /instagram\.com\/stories\/([^/?#]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return match[1];
        }
    }
    return null;
}

// Helper function to validate Instagram URL
function isValidInstagramUrl(url) {
    if (!url) return false;
    
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    
    const instagramPattern = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|stories)\/[\w-]+/i;
    return instagramPattern.test(url);
}

// Main scraping function
async function scrapeInstagramPost(postUrl) {
    try {
        // Clean and validate URL
        if (!postUrl.startsWith('http://') && !postUrl.startsWith('https://')) {
            postUrl = 'https://' + postUrl;
        }
        
        // Extract shortcode
        const shortcode = extractShortcode(postUrl);
        if (!shortcode) {
            throw new Error('Invalid Instagram URL format');
        }

        // Headers to mimic a browser
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Cache-Control': 'max-age=0'
        };

        console.log(`Scraping URL: ${postUrl}`);
        
        // Make request with timeout
        const response = await axios.get(postUrl, {
            headers,
            timeout: 30000,
            maxRedirects: 5
        });

        const $ = cheerio.load(response.data);
        
        // Method 1: Look for JSON in script tags
        const scriptTags = $('script[type="text/javascript"]');
        
        for (let i = 0; i < scriptTags.length; i++) {
            const scriptContent = $(scriptTags[i]).html();
            if (scriptContent && scriptContent.includes('window._sharedData')) {
                try {
                    const jsonStr = scriptContent.match(/window\._sharedData\s*=\s*({.+?});/)[1];
                    const data = JSON.parse(jsonStr);
                    
                    if (data.entry_data && data.entry_data.PostPage) {
                        const media = data.entry_data.PostPage[0].graphql.shortcode_media;
                        return extractMediaData(media);
                    }
                } catch (e) {
                    console.log('Failed to parse _sharedData:', e.message);
                }
            }
            
            // Try another pattern
            if (scriptContent && scriptContent.includes('"shortcode_media"')) {
                try {
                    const jsonMatch = scriptContent.match(/"shortcode_media":({.+?}),"user"/);
                    if (jsonMatch) {
                        const media = JSON.parse(jsonMatch[1]);
                        return extractMediaData(media);
                    }
                } catch (e) {
                    console.log('Failed to parse shortcode_media:', e.message);
                }
            }
        }

        // Method 2: Look for meta tags as fallback
        const videoMeta = $('meta[property="og:video"]').attr('content');
        const imageMeta = $('meta[property="og:image"]').attr('content');
        
        if (videoMeta) {
            return {
                downloadUrl: videoMeta,
                thumbnailUrl: imageMeta || videoMeta,
                type: 'video'
            };
        } else if (imageMeta) {
            return {
                downloadUrl: imageMeta,
                thumbnailUrl: imageMeta,
                type: 'image'
            };
        }

        throw new Error('Could not extract media data from the post');

    } catch (error) {
        console.error('Scraping error:', error.message);
        throw error;
    }
}

// Helper function to extract media data from Instagram's data structure
function extractMediaData(media) {
    const isVideo = media.is_video || false;
    
    if (isVideo) {
        return {
            downloadUrl: media.video_url,
            thumbnailUrl: media.display_url,
            type: 'video'
        };
    } else {
        // For carousel posts, get the first item
        if (media.edge_sidecar_to_children) {
            const firstItem = media.edge_sidecar_to_children.edges[0].node;
            return {
                downloadUrl: firstItem.display_url,
                thumbnailUrl: firstItem.display_url,
                type: firstItem.is_video ? 'video' : 'image'
            };
        }
        
        return {
            downloadUrl: media.display_url,
            thumbnailUrl: media.display_url,
            type: 'image'
        };
    }
}

// API endpoint for downloading
app.post('/api/download', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({
                error: 'URL is required'
            });
        }

        if (!isValidInstagramUrl(url)) {
            return res.status(400).json({
                error: 'Please provide a valid Instagram URL (post, reel, stories, or IGTV)'
            });
        }

        console.log(`Processing request for URL: ${url}`);

        const result = await scrapeInstagramPost(url);

        if (result) {
            res.json({
                downloadUrl: result.downloadUrl,
                thumbnailUrl: result.thumbnailUrl,
                type: result.type,
                success: true
            });
        } else {
            res.status(404).json({
                error: 'Could not retrieve content. The post may be private, deleted, or not supported.'
            });
        }

    } catch (error) {
        console.error('API Error:', error);
        
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            res.status(503).json({
                error: 'Network error. Please check your internet connection and try again.'
            });
        } else if (error.response && error.response.status === 404) {
            res.status(404).json({
                error: 'Post not found. The URL may be incorrect or the post may have been deleted.'
            });
        } else if (error.response && error.response.status === 429) {
            res.status(429).json({
                error: 'Too many requests. Please wait a moment and try again.'
            });
        } else {
            res.status(500).json({
                error: 'Failed to process the request. Please try again later.'
            });
        }
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Instagram Downloader API is running',
        timestamp: new Date().toISOString()
    });
});

// Error handlers
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found'
    });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: 'Internal server error'
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`
🚀 Instagram Downloader API is running!
📡 Server: http://localhost:${PORT}
🔗 Health Check: http://localhost:${PORT}/api/health
💡 Make sure to put your index.html in the 'public' folder
    `);
});