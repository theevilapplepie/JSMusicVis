import { WebGPURenderer } from './webgpu-renderer.js';
import { parseBlob } from 'music-metadata-browser';
import Stats from 'stats.js';
import { Notyf } from 'notyf';
import 'notyf/notyf.min.css';
import { Buffer as BufferPolyfill } from 'buffer/';

// Make Buffer globally available for music-metadata-browser
window.Buffer = BufferPolyfill;
globalThis.Buffer = BufferPolyfill;

// Add icons
import { addIcons } from 'ionicons';
import { defineCustomElement } from 'ionicons/components/ion-icon.js';
import { musicalNotesOutline, musicalNotes, repeatOutline, addCircleOutline, trashOutline, closeCircleOutline, chevronBack, playSharp, pauseSharp, chevronForward, volumeMedium, volumeMute, chevronBackOutline, chevronForwardOutline, reorderTwo  } from 'ionicons/icons';

addIcons({ musicalNotesOutline, musicalNotes, repeatOutline, addCircleOutline, trashOutline, closeCircleOutline, chevronBack, playSharp, pauseSharp, chevronForward, volumeMedium, volumeMute, chevronBackOutline, chevronForwardOutline, reorderTwo });
defineCustomElement();

// Make Stats and Notyf globally available
window.Stats = Stats;
window.Notyf = Notyf;

/* General functions */
function setStorage(name,value,days) {
    sessionStorage.setItem(name, value);
}

function getStorage(name) {
    return sessionStorage.getItem(name);
}

function getRandomIntInclusive(min, max) {
    const minCeiled = Math.ceil(min);
    const maxFloored = Math.floor(max);
    return Math.floor(Math.random() * (maxFloored - minCeiled + 1) + minCeiled); // The maximum is inclusive and the minimum is inclusive
}

function secondsToTime(inputsec) {
    let hr = Math.trunc(inputsec / 60 / 60);
    let hrsec = hr * 60 * 60;
    let min = Math.trunc( (inputsec - hrsec) / 60 );
    let minsec = min * 60;
    let sec = Math.trunc(inputsec - hrsec - minsec);
    return String(hr).padStart(2,'0') + ':' + String(min).padStart(2,'0') + ':' + String(sec).padStart(2,'0')
}

/* Configuration and Global Variables */
let bufferLength = 512;
let dataArray = new Uint8Array(bufferLength);

// Playlist management
let playlist = [];
let currentTrackIndex = -1;
let repeatMode = 'off'; // 'off', 'all', 'one'

var notyf = new Notyf({
    duration: 3000,
});

var canvas, audio, source, context, analyser, stats, mid_y, heightChunks, sliceWidth;

var savedFile = '';
var savedTime = 0;

var clearFrame = 0;
var updateWaveform = 0;
var lastFrameTime = 0;
var wasPlaying = 0;
var targetFrameTime = 1000 / 80; // 60fps (30 fps = ~33.33ms per frame)

var avg_r = 0;
var avg_g = 0;
var avg_b = 0;

// WebGPU Renderer instance
let renderer = null;

/* Main Application Methods */
function resizeCanvas() {
    if (!renderer) return;
    
    // Cleanup resize within renderer
    renderer.resizeCanvas();
    
    // Calculate rendering parameters that gets used within frameLooper
    const mid_x = canvas.width / 2;
    mid_y = canvas.height / 2;

    if ( canvas.width > bufferLength ) {
        sliceWidth =  canvas.width / (bufferLength - 1);
    } else {
        sliceWidth =  (bufferLength - 1) / canvas.width;
    }
    sliceWidth = Math.max(sliceWidth, 3);
    // Adjust height chunks based on canvas size
    heightChunks = (canvas.height / 256) * .8;
}

function frameLooper(currentTime){

    // Short cirucuit if paused
    if ( audio.paused ) {
        return;
    }

    // Cap framerate based on targetFrameTime
    const deltaTime = currentTime - lastFrameTime;
    if (deltaTime < targetFrameTime) {
        return window.requestAnimationFrame(frameLooper);
    }
    lastFrameTime = currentTime;

    stats.begin();

    // Get audio data if needed
    let audioDataToRender = null;
    if (updateWaveform) {
        analyser.getByteTimeDomainData(dataArray);
        audioDataToRender = dataArray;

        // Update color values
        if ( isNaN(avg_r) || isNaN(avg_g) || isNaN(avg_b) || // if averages are not set
                ((avg_r - avg_g) < 50 && (avg_g - avg_b) < 50  && (avg_b - avg_g) < 50) || // if the different values are too similar ( eg: bland )
                ( avg_r < 128 && avg_g < 128 && avg_b < 128 ) // if it's not bright enough
        ) {
            while ( avg_r < 200 && avg_g < 200 && avg_b < 200 ) {
                avg_r = getRandomIntInclusive(0,255);
                avg_g = getRandomIntInclusive(0,255);
                avg_b = getRandomIntInclusive(0,255);
            }
        }

        avg_r = Math.min(avg_r + getRandomIntInclusive(0,20), 255);
        avg_r = Math.max(avg_r - getRandomIntInclusive(0,20),0);
        
        avg_g = Math.min(avg_g + getRandomIntInclusive(0,20), 255);
        avg_g = Math.max(avg_g - getRandomIntInclusive(0,20),0);

        avg_b = Math.min(avg_b + getRandomIntInclusive(0,20), 255);
        avg_b = Math.max(avg_b - getRandomIntInclusive(0,20),0);
    }

    // Render frame using WebGPU renderer
    renderer.renderFrame({
        clearFrame: clearFrame,
        updateWaveform: updateWaveform,
        audioData: audioDataToRender,
        colorRGB: { r: avg_r, g: avg_g, b: avg_b },
        mid_y: mid_y,
        heightChunks: heightChunks,
        sliceWidth: sliceWidth
    });

    // Clear single frame action bools
    clearFrame = 0;
    updateWaveform = 0;

    // End stats monitoring ( report )
    stats.end();

    // Request next frame
    return window.requestAnimationFrame(frameLooper);
}

function setupStatsOverlay() {
    // Setup Stats overlay
    stats = new Stats();
    stats.showPanel( 0 ); // 0: fps, 1: ms, 2: mb, 3+: custom
    stats.dom.style.setProperty('right','0px');
    stats.dom.style.setProperty('left','unset');
    document.body.appendChild( stats.dom );
}

async function setupWebGPURenderer() {
    // Setup Canvas and WebGPU
    canvas = document.getElementById('canvas');
    
    // Handle resize events
    window.addEventListener('resize', resizeCanvas, false);
    
    // Handle orientation changes (especially important for iOS)
    window.addEventListener('orientationchange', () => {
        // iOS needs a small delay after orientation change
        setTimeout(() => {
            resizeCanvas();
        }, 100);
    }, false);
    
    // Also handle visual viewport resize (for iOS address bar appearing/disappearing)
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            resizeCanvas();
        });
    }
    
    // Initialize WebGPU Renderer
    try {
        renderer = new WebGPURenderer();
        await renderer.initialize(canvas,bufferLength);
        resizeCanvas();
    } catch (error) {
        notyf.error('WebGPU Initialization Error: ' + error.message);
        return;
    }
}

function setupAudioPlayerAndAnalyser() {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = bufferLength;
    source = context.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(context.destination);
}

async function changeAudioFile(filepath,autoplay=true) {
    // Ensure our audio is paused before changing the file ( or bad things )
    // and set our time index to 0
    await audio.pause();
    audio.currentTime = 0;
    // Thanks firefox...
    await audio.dispatchEvent(new Event('pause',{})); // Manually dispatch pause event for FF
    await audio.dispatchEvent(new Event('timeupdate',{})); // FF required manual dispatch
    setStorage('playback_timeindex',0,7);
    // Reset canvas
    renderer.resizeCanvas();
    // Load file and optionally start playback
    audio.src = filepath;
    // We have to wait for load or we hit race conditions
    await audio.load();
    // Do we have a restorable time index for this file? ( we backed up the initial file/time at load )
    if ( savedFile == filepath && savedTime && savedTime > 0 ) {
        // We do!
        //console.log("Restoring time index to ", savedTime);
        audio.currentTime = savedTime;
        await audio.dispatchEvent(new Event('timeupdate',{})); // FF required manual dispatch
    }
    if ( autoplay ) {
        const playPromise = audio.play();
        if (playPromise == undefined) {
            return;
        }
        await playPromise.then(() => {
            console.log('Autoplay allowed and audio is playing.');
        }).catch(error => {
            // Ignore AbortError - this happens when play() is interrupted by pause() 
            // during rapid track changes, which is expected behavior
            if (error.name === 'AbortError') {
                return;
            }
            // Log other autoplay prevention errors
            console.log('Autoplay blocked:', error);
            notyf.error('Autoplay blocked by browser. Please click play to start audio.');
        });     
    }
}

function setPlayerDefaultText() {
    document.getElementById('player-title').innerHTML = 'Click the icon';
    document.getElementById('player-artist').innerHTML = '<span style="font-size: .9em;">to open playlist</span>';
    document.getElementById('player_runtime').innerHTML = secondsToTime(0);
    document.getElementById('player_duration').innerHTML = secondsToTime(0);
}

/* Playlist Management Functions */

function scrollCurrentTrackIntoView(ignoreOpen=false) {
    if ( currentTrackIndex < 0 ) {
        // We don't have anything to scroll into view
        return;
    }
    if ( document.getElementById('playlist-wrapper').classList.contains('open') || ignoreOpen ) {
        const activeItem = document.querySelector('.playlist-item.active');
        if (activeItem) {
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

function togglePlaylist() {
    const playlistWrapper = document.getElementById('playlist-wrapper');
    const playlistContainer = document.querySelector('.playlist-container');
    const isOpening = !playlistWrapper.classList.contains('open');
    // Temporarily disable showing scrollbars as we open if
    // the "add songs to playlist" message is showing
    if ( playlist.length === 0 ) {
        playlistContainer.classList.add('noscroll');
    }
    playlistWrapper.classList.toggle('open');
    setTimeout(() => {
        playlistContainer.classList.remove('noscroll');
    }, 400);

    // Scroll active item into view when opening
    if (isOpening && currentTrackIndex >= 0) {
        setTimeout(() => {
            // Set ignoreOpen as it may not be fully open yet
            scrollCurrentTrackIntoView(true);
        }, 300); // Wait for playlist open animation to complete
    }
}

function updatePlaylistUI() {
    const playlistItems = document.getElementById('playlist-items');
    const loadingDiv = document.getElementById('playlist-loading');
    
    if (playlist.length === 0) {
        playlistItems.innerHTML = `
            <div class="playlist-empty">
                <ion-icon name="musical-notes-outline"></ion-icon>
                <p>No songs in playlist</p>
                <p class="playlist-empty-hint">Click + to add music files</p>
            </div>
        `;
        return;
    }
    
    playlistItems.innerHTML = '';
    playlist.forEach((track, index) => {
        const item = document.createElement('div');
        item.className = 'playlist-item';
        item.dataset.index = index;
        if (index === currentTrackIndex) {
            item.classList.add('active');
        }
        let title = "";
        if ( track.artist ) {
            title = `${track.artist} - `;
        }
        title += track.title;
        item.innerHTML = `
            <ion-icon name="reorder-two" class="playlist-item-drag-handle"></ion-icon>
            <div class="playlist-item-info">
                <div class="playlist-item-title">${title}</div>
                <div class="playlist-item-duration">${track.duration}</div>
            </div>
            <ion-icon name="close-circle-outline" class="playlist-item-remove"></ion-icon>
        `;
        
        // Click to play
        item.querySelector('.playlist-item-info').addEventListener('click', () => {
            if (index !== currentTrackIndex) {
                playTrack(index);
            } else if ( audio.paused ) {
                audio.play();
            }
        });
        
        // Remove track
        item.querySelector('.playlist-item-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            removeTrack(index);
        });
        
        // Drag and drop
        item.draggable = true;
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragover', handleDragOver);
        item.addEventListener('drop', handleDrop);
        item.addEventListener('dragend', handleDragEnd);
        
        playlistItems.appendChild(item);
    });
}

function showPlaylistLoading() {
    const loadingDiv = document.querySelector('#playlist-loading');
    if (loadingDiv) {
        loadingDiv.style.display = 'flex';
    }
    // Blur the playlist-add button
    const addBtn = document.getElementById('playlist-add');
    if (addBtn) {
        addBtn.blur();
    }
}

function hidePlaylistLoading() {
    const loadingDiv = document.querySelector('#playlist-loading');
    if (loadingDiv) {
        loadingDiv.style.display = 'none';
    }
}

async function addTracksToPlaylist(files) {
    let loadingTextElement = document.getElementById('playlist-loading-text');
    let currentFileCount = 0;
        
    for (const file of files) {
        currentFileCount++;
        loadingTextElement.innerHTML = `Processing file ${currentFileCount} of ${files.length}<br/><span class="loading-filename">${file.name}</span>`;
        // Default fallback to filename
        let title = file.name.replace(/\.[^.]+$/, '');
        let artist = null;
        let album = null;
        let duration = 0;
        
        // Try to extract metadata
        try {
            let metadata = await parseBlob(file);
            if ( metadata && metadata.common ) {
                if ( metadata.common.title ) {
                    title = metadata.common.title;
                }
                artist = metadata.common.artist;
                album = metadata.common.album;
            }
            if ( metadata && metadata.format ) {
                duration = metadata.format.duration;
            }
        } catch (error) {
            // Metadata extraction failed, use filename
            console.log('Could not extract metadata for', file.name, error);
        }
        
        const track = {
            title: title,
            artist: artist,
            album: album,
            file: file,
            url: URL.createObjectURL(file),
            duration: secondsToTime(duration)
        };
        playlist.push(track);
    }
    
    if (currentTrackIndex === -1 && playlist.length > 0) {
        await playTrack(0);
    }
    
    updatePlaylistUI();
}

async function removeTrack(index) {

    // Are we removing the playing track?
    if (index === currentTrackIndex) {
        // Is there another track to play?
        if ( playlist.length > 1 ) {
            // There is! And this the last track?
            if ( index == playlist.length - 1 ) {
                // It is!
                // Are we supposed to loop?
                if ( repeatMode === 'all' ) {
                    // Then just use playNext and let the normal operation handle it
                    await playNext();
                } else {
                    // We are not supposed to loop so we have to back up one track
                    // Even if the current track is playing we are not going to play the previous track
                    // You don't have looping enabled and just removed the last track, I'm going to make
                    // it be equivalent to if the prior track had ended naturally.
                    await playTrack(index - 1,false);
                }
            } else {
                // We have another track we can play, so go to it.
                await playNext();
            }
        } else {
            // There are no other tracks to play, so we prepare to be deleted in a moment.
            await audio.pause();
        }
    }
    
    // Everything above is an await because lord have mercy
    // revoking this URL means that it MUST be out of use

    // Revoke URL to free memory
    if (playlist[index].url) {
        URL.revokeObjectURL(playlist[index].url);
    }

    // Remove the requested track index
    playlist.splice(index, 1);

    // Adjust currentTrackIndex if needed
    // If the removed index is less than currentTrackIndex, we need to decrement it so it matches
    if ( index < currentTrackIndex ) {
        currentTrackIndex--;
    }

    // Is this the last track?
    // Set us back to uninitialized
    if ( playlist.length === 0 ) {
        currentTrackIndex = -1;
        setPlayerDefaultText();
    }

    // Ensure the UI is updated
    updatePlaylistUI();
}

function clearPlaylist() {
    if (playlist.length === 0) return;
    
    if (confirm('Clear entire playlist?')) {
        audio.pause();
        playlist.forEach(track => {
            if (track.url) {
                URL.revokeObjectURL(track.url);
            }
        });
        playlist = [];
        currentTrackIndex = -1;
        updatePlaylistUI();
        setPlayerDefaultText();
    }
}

async function playTrack(index,autoplay=true) {
    if (index < 0 || index >= playlist.length) return;
    
    currentTrackIndex = index;
    const track = playlist[index];

    document.getElementById('player-title').innerHTML = track.title;
    
    // Show artist info or track position
    if (track.artist) {
        document.getElementById('player-artist').innerHTML = track.artist;
    } else {
        document.getElementById('player-artist').innerHTML = 'Unknown Artist';
    }
    
    // Update Media Session metadata
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title || 'Unknown Track',
            artist: track.artist || 'Unknown Artist',
            album: track.album || 'Unknown Album'
        });
    }
    
    await changeAudioFile(track.url,autoplay);
    updatePlaylistUI();
    scrollCurrentTrackIntoView();
}

async function playNext() {
    // If we have nothing, do nothing
    // The currentTrackIndex check ensures that we've initialized the index
    // before allowing a play next
    if (playlist.length === 0 || currentTrackIndex < 0 ) return;

    // If we're repeating the current track then just play it again
    // we get called at the end of the track for auto-advance
    if (repeatMode === 'one') {
        // Replay current track
        audio.currentTime = 0;
        audio.play();
        return;
    }
    
    // Are we on the last track of the playlist?
    if ( currentTrackIndex == playlist.length - 1 ) {
        // Are we looping the playlist?
        if ( repeatMode === 'all' ) {
            // We are, so start at the beginning again.
            await playTrack(0);
            return;
        }
        // We originally stopped playing on next at end of playlist,
        // but this produced a unintuitive result where the user's music just stopped
        // so we're just going to do nothing if it's the last track and we're not
        // looping the playlist.
        if ( ! audio.paused ) {
            // I wanted a message? idk. This was from earlier when I was figuring stuff out.
            console.log("Attempted to go to next track at end of playlist while actively playing last track - ignoring.");
        }
        return;
    }

    // We have a normal next, so just do it
    playTrack(currentTrackIndex + 1);
}

function playPrevious() {
    if (playlist.length === 0) return;
    if (currentTrackIndex === 0) return;
    playTrack(currentTrackIndex - 1);
}

function toggleRepeatMode() {
    const modes = ['off', 'all', 'one'];
    const currentIndex = modes.indexOf(repeatMode);
    repeatMode = modes[(currentIndex + 1) % modes.length];
    
    const repeatBtn = document.getElementById('playlist-repeat');
    repeatBtn.dataset.mode = repeatMode;
    
    const titles = {
        'off': 'Repeat off',
        'all': 'Repeat playlist',
        'one': 'Repeat one'
    };
    repeatBtn.title = titles[repeatMode];
    
    setStorage('repeat_mode', repeatMode, 7);
}

// Drag and drop handlers
let draggedElement = null;

function handleDragStart(e) {
    draggedElement = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    
    const target = e.target.closest('.playlist-item');
    if (target && target !== draggedElement) {
        const rect = target.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        
        if (e.clientY < midpoint) {
            target.parentNode.insertBefore(draggedElement, target);
        } else {
            target.parentNode.insertBefore(draggedElement, target.nextSibling);
        }
    }
    
    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    
    // Reorder playlist array based on new DOM order
    const items = document.querySelectorAll('.playlist-item');
    const newPlaylist = [];
    let newCurrentIndex = -1;
    
    items.forEach((item, index) => {
        const oldIndex = parseInt(item.dataset.index);
        newPlaylist.push(playlist[oldIndex]);
        if (oldIndex === currentTrackIndex) {
            newCurrentIndex = index;
        }
    });
    
    playlist = newPlaylist;
    currentTrackIndex = newCurrentIndex;
    updatePlaylistUI();
    
    return false;
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
    draggedElement = null;
}

/* Application Entry Point */

async function appSetup() {
    // Perform Setup
    setupStatsOverlay();
    await setupWebGPURenderer();
    setPlayerDefaultText();

    audio = document.getElementById('audio_player');

    audio.addEventListener('error', (event) => {
        console.error('Audio loading error:', audio.error.code, audio.error.message);
        if ( audio.error.message.includes('open context failed') ) {
            notyf.error('Failed to open audio file! Please check the file path and try again.');
        } else {
            notyf.error('Audio loading error: ' + audio.error.message);
        }
        setPlayerDefaultText();
    })
    audio.addEventListener('loadstart', (e) => {
        setStorage('playback_file',audio.src,7);
        // Temporarily just display the filename ( we were using ID3 but that's been removed for now )
        // Don't set it for blob types and assume it's being set elsewhere
        if ( ! audio.src.startsWith('blob:') ) {
            document.getElementById('player-title').innerHTML = audio.src.split('/').pop();
            document.getElementById('player-artist').innerHTML = '';
        }
    });
    audio.addEventListener('loadedmetadata', (e) => {
        slider.max = audio.duration;
        document.getElementById('player_duration').innerHTML = secondsToTime(audio.duration);
        
        // Update duration in playlist
        if (currentTrackIndex >= 0) {
            playlist[currentTrackIndex].duration = secondsToTime(audio.duration);
            updatePlaylistUI();
        }
    });
    audio.addEventListener('play', (e) => {
        if ( ! audio.src ) {
            e.preventDefault();
            return;
        }
        // We have to have had an interaction to set up our analyzer so we're just going to
        // hairpin running it here as the assumption is calling code makes that guarantee
        if ( ! context ) {
            setupAudioPlayerAndAnalyser();
        }
        setStorage('playback_state','playing',0);
        document.getElementById('controls_play').style.display = 'none';
        document.getElementById('controls_pause').style.display = 'inherit';
        // Start our visualization loop again ( it will stop on pause automatically )
        window.requestAnimationFrame(frameLooper);
    });
    audio.addEventListener('pause', (e) => {
        setStorage('playback_state','paused',0);
        document.getElementById('controls_play').style.display = 'inherit';
        document.getElementById('controls_pause').style.display = 'none';
    });
    
    // Set up Media Session API handlers
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => {
            audio.play();
        });
        
        navigator.mediaSession.setActionHandler('pause', () => {
            audio.pause();
        });
        
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            playPrevious();
        });
        
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            playNext();
        });
    }                
    audio.addEventListener("volumechange", (e) => {
        setStorage('playback_vol',audio.volume,7);
    });
    audio.addEventListener("timeupdate", (event) => {
        // This covers the case where it gets called to initialize things before a file is loaded.
        if ( isNaN(audio.duration) || ! audio.src ) {
            slider.max = 100;
            slider.value = 0;
            document.getElementById('player_runtime').innerHTML = secondsToTime(0);
            document.getElementById('player_duration').innerHTML = secondsToTime(0);
        } else {
            slider.max = audio.duration;
            slider.value = audio.currentTime;
            setStorage('playback_timeindex',audio.currentTime,7);
            document.getElementById('player_runtime').innerHTML = secondsToTime(audio.currentTime);
            document.getElementById('player_duration').innerHTML = secondsToTime(audio.duration);
        }
    });
    audio.addEventListener('ended', (e) => {
        playNext();
    });

    // Player Audio File Input
    document.getElementById('player_file').addEventListener('change', async (e) => {
        if ( e.currentTarget.files.length == 0 ) {
            return;
        }
        const input = e.currentTarget;
        showPlaylistLoading();
        try {
            await addTracksToPlaylist(Array.from(input.files));
        } catch (error) {
            console.error('Error adding tracks:', error);
            notyf.error('Error adding tracks: ' + error.message);
        } finally {
            hidePlaylistLoading();
            // Reset the input so the same files can be added again if needed
            input.value = '';
        }
    });

    // Music icon opens playlist
    document.getElementById('music_icon').addEventListener('click', (e) => {
        togglePlaylist();
    });

    // Playlist controls
    document.getElementById('playlist-repeat').addEventListener('click', (e) => {
        toggleRepeatMode();
    });
    
    document.getElementById('playlist-add').addEventListener('click', (e) => {
        document.getElementById('player_file').click();
    });
    
    document.getElementById('playlist-clear').addEventListener('click', (e) => {
        clearPlaylist();
    });
    
    // Close playlist when clicking on canvas
    document.getElementById('canvas').addEventListener('click', (e) => {
        const playlistWrapper = document.getElementById('playlist-wrapper');
        if (playlistWrapper.classList.contains('open')) {
            togglePlaylist();
        }
    });

    // Player Controls
    document.querySelector('.prev').addEventListener('click', (e) => {
        playPrevious();
    });
    
    document.querySelector('.next').addEventListener('click', (e) => {
        playNext();
    });
    document.getElementById('controls_play').children[0].addEventListener("click", (e) => {
        audio.play();
    });
    document.getElementById('controls_pause').children[0].addEventListener("click", (e) => {
        audio.pause();
    });

    let slider = document.getElementById('player_slider');
    slider.value = 0; // Fixing Firefox bug where it starts at 1?
    slider.addEventListener('input', (e) => {
        audio.currentTime = slider.value;
    });
    slider.addEventListener('mousedown',(e) => {
        if ( ! audio.src ) {
            e.preventDefault();
            return;
        }
        wasPlaying = ! audio.paused;
        audio.pause();
    });
    slider.addEventListener('mouseup',(e) => {
        if ( wasPlaying ) {
            audio.play();
        }
    });

    // Setup hide/show player toggle
    document.getElementById('player-hide').addEventListener('click', (e) => {
        const wrapper = document.getElementById('player-wrapper');
        const hideBack = document.getElementById('hide-back');
        const hideForward = document.getElementById('hide-forward');
        const playlistWrapper = document.getElementById('playlist-wrapper');        
        
        if (wrapper.classList.contains('hidden')) {
            // We are unhiding the player
            wrapper.classList.toggle('hidden');
            hideBack.style.display = 'block';
            hideForward.style.display = 'none';
        } else {
            // We are hiding the player
                // If playlist is open, close it first and wait
            if( playlistWrapper.classList.contains('open') ) {
                playlistWrapper.classList.remove('open');
                // Wait for playlist to "disappear" before hiding
                console.log("Waiting to hide player until playlist is closed");
                setTimeout(() => {
                    console.log("Hiding player now");
                    wrapper.classList.toggle('hidden');
                    hideBack.style.display = 'none';
                    hideForward.style.display = 'block';
                }, 400);
                return;
            }
            // Just hide immediately
            wrapper.classList.toggle('hidden');
            hideBack.style.display = 'none';
            hideForward.style.display = 'block';
        }
    });

    // Setup volume slider toggle and controls
    const volumeSliderContainer = document.getElementById('volume-slider-container');
    const volumeSlider = document.getElementById('volume_slider');
    const volButton = document.getElementById('vol');
    const volMuteButton = document.getElementById('vol_mute');
    
    // Toggle volume slider visibility
    volButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (volumeSliderContainer.style.display === 'none') {
            volumeSliderContainer.style.display = 'flex';
        } else {
            volumeSliderContainer.style.display = 'none';
        }
    });
    
    volMuteButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (volumeSliderContainer.style.display === 'none') {
            volumeSliderContainer.style.display = 'flex';
        } else {
            volumeSliderContainer.style.display = 'none';
        }
    });
    
    // Close volume slider when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.volume')) {
            volumeSliderContainer.style.display = 'none';
        }
    });
    
    // Sync volume slider with audio volume
    volumeSlider.addEventListener('input', (e) => {
        const volume = e.target.value / 100;
        audio.volume = volume;
        
        // Update volume icon
        if (volume === 0) {
            volButton.style.display = 'none';
            volMuteButton.style.display = 'block';
        } else {
            volButton.style.display = 'block';
            volMuteButton.style.display = 'none';
        }
    });

    // Setup some cpu based timers for the visualization
    setInterval( () => {
        clearFrame = 1;
    }, 100);
    setInterval( () => {
        updateWaveform = 1;
    }, 50);

    // Restore previous state
    savedFile = getStorage('playback_file');
    savedTime = getStorage('playback_timeindex');
    
    let savedPlaybackState = getStorage('playback_state') == 'playing' ? 1 : 0;
        // We can't automagically restore usage of local files without user interaction due to browser safety
    if ( savedFile && ! savedFile.startsWith('blob:') ) {
        await changeAudioFile(savedFile,savedPlaybackState);
    } else {
        // Temporarily always restore "music.opus" as the default audio file so I don't
        // pull my hair out having to manually pick a file after each reload.
        if ( location.hostname == "127.0.0.1" ) {
            await changeAudioFile('musisc.opus',false);
        }
    }
    let last_vol = getStorage('playback_vol');
    if ( last_vol ) {
        audio.volume = last_vol;
        volumeSlider.value = audio.volume * 100;
    }
    
    // Restore repeat mode
    let savedRepeatMode = getStorage('repeat_mode');
    if (savedRepeatMode && ['off', 'all', 'one'].includes(savedRepeatMode)) {
        repeatMode = savedRepeatMode;
        const repeatBtn = document.getElementById('playlist-repeat');
        repeatBtn.dataset.mode = repeatMode;
        const titles = {
            'off': 'Repeat off',
            'all': 'Repeat playlist',
            'one': 'Repeat one'
        };
        repeatBtn.title = titles[repeatMode];
    }
}

window.addEventListener("load", async () => {
    await appSetup();
}, false);