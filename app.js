import { WebGPURenderer } from './webgpu-renderer.js';

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
        sliceWidth =  canvas.width / bufferLength;
    } else {
        sliceWidth =  bufferLength / canvas.width;
    }
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
    window.addEventListener('resize', resizeCanvas, false);
    
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
        playPromise.then(() => {
            console.log('Autoplay allowed and audio is playing.');
        }).catch(error => {
            // Autoplay was prevented
            console.log('Autoplay blocked:', error);
            notyf.error('Autoplay blocked by browser. Please click play to start audio.');
        });     
    }
}

function setPlayerDefaultText() {
    document.getElementById('player-title').innerHTML = 'Click the icon';
    document.getElementById('player-artist').innerHTML = '<span style="font-size: .9em;">and select a music file from your device</span>';
    document.getElementById('player_runtime').innerHTML = secondsToTime(0);
    document.getElementById('player_duration').innerHTML = secondsToTime(0);
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

    // Player Audio File Input
    document.getElementById('player_file').addEventListener('change', (e) => {
        if ( e.currentTarget.files.length == 0 ) {
            return;
        }
        // Overload setting the name as it's not that simple for local filesystem blobs
        let fileName = e.currentTarget.files[0].name
        fileName = fileName.replace(/\.[^ ]+$/,'');
        document.getElementById('player-title').innerHTML = fileName;
        document.getElementById('player-artist').innerHTML = '< Click the icon to change music';
        // Load the new file
        changeAudioFile(URL.createObjectURL(e.currentTarget.files[0]));
    });

    // Player Controls
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
        
        wrapper.classList.toggle('hidden');
        
        if (wrapper.classList.contains('hidden')) {
            hideBack.style.display = 'none';
            hideForward.style.display = 'block';
        } else {
            hideBack.style.display = 'block';
            hideForward.style.display = 'none';
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
        changeAudioFile(savedFile,savedPlaybackState);
    } else {
        // Temporarily always restore "music.opus" as the default audio file so I don't
        // pull my hair out having to manually pick a file after each reload.
        if ( location.hostname == "127.0.0.1" ) {
            changeAudioFile('musisc.opus',false);
        }
    }
    let last_vol = getStorage('playback_vol');
    if ( last_vol ) {
        audio.volume = last_vol;
    }
}

window.addEventListener("load", async () => {
    await appSetup();
}, false);