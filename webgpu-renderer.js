// WebGPU Renderer Module
// Handles all WebGPU initialization, pipeline creation, and rendering

export class WebGPURenderer {
    constructor() {
        // GPU resources
        this.device = null;
        this.gpuContext = null;
        this.canvasFormat = null;
        
        // Pipelines
        this.blurPipeline = null;
        this.waveformPipeline = null;
        this.copyPipeline = null;
        this.compositePipeline = null;
        
        // Textures
        this.renderTexture = null;
        this.tempTexture = null;
        this.msaaTexture = null;
        this.waveformTexture = null;
        
        // Buffers
        this.uniformBuffer = null;
        this.audioDataBuffer = null;
        this.colorUniformBuffer = null;
        this.copySampler = null;
        
        // Config
        this.sampleCount = 4; // MSAA sample count
        this.scaleFactor = 1.3; // Canvas scaling factor for better quality
        this.bufferLength = null;
    }

    async initialize(canvas,bufferLength=512) {
        this.canvas = canvas;
        this.bufferLength = bufferLength;
        
        // Initialize WebGPU
        if (!navigator.gpu) {
            throw new Error("WebGPU not supported on this browser.");
        }
        
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("Failed to get GPU adapter.");
        }
        
        this.device = await adapter.requestDevice();
        this.gpuContext = canvas.getContext('webgpu');
        
        this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        this.gpuContext.configure({
            device: this.device,
            format: this.canvasFormat,
            alphaMode: 'opaque'
        });
        
        await this.initWebGPUPipelines();
        await this.initCopyPipeline();
    }

    async initCopyPipeline() {
        const copyShader = `
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) texCoord: vec2<f32>,
            }

            @vertex
            fn vertMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                var pos = array<vec2<f32>, 6>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>(1.0, -1.0),
                    vec2<f32>(-1.0, 1.0),
                    vec2<f32>(-1.0, 1.0),
                    vec2<f32>(1.0, -1.0),
                    vec2<f32>(1.0, 1.0)
                );
                var texCoord = array<vec2<f32>, 6>(
                    vec2<f32>(0.0, 1.0),
                    vec2<f32>(1.0, 1.0),
                    vec2<f32>(0.0, 0.0),
                    vec2<f32>(0.0, 0.0),
                    vec2<f32>(1.0, 1.0),
                    vec2<f32>(1.0, 0.0)
                );
                var output: VertexOutput;
                output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
                output.texCoord = texCoord[vertexIndex];
                return output;
            }

            @group(0) @binding(0) var srcTexture: texture_2d<f32>;
            @group(0) @binding(1) var srcSampler: sampler;

            @fragment
            fn fragMain(input: VertexOutput) -> @location(0) vec4<f32> {
                return textureSample(srcTexture, srcSampler, input.texCoord);
            }
        `;

        const copyModule = this.device.createShaderModule({ code: copyShader });
        this.copyPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: copyModule,
                entryPoint: 'vertMain'
            },
            fragment: {
                module: copyModule,
                entryPoint: 'fragMain',
                targets: [{
                    format: this.canvasFormat
                }]
            },
            primitive: {
                topology: 'triangle-list'
            }
        });
        
        // Create composite pipeline for rgba8unorm with blending
        this.compositePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: copyModule,
                entryPoint: 'vertMain'
            },
            fragment: {
                module: copyModule,
                entryPoint: 'fragMain',
                targets: [{
                    format: 'rgba8unorm',
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        }
                    }
                }]
            },
            primitive: {
                topology: 'triangle-list'
            }
        });
    }

    async initWebGPUPipelines() {
        // Compute shader for blur effect
        const blurShader = `
            @group(0) @binding(0) var inputTex: texture_2d<f32>;
            @group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
            @group(0) @binding(2) var<uniform> uniforms: Uniforms;

            struct Uniforms {
                width: u32,
                height: u32,
                clearFrame: u32,
            }

            @compute @workgroup_size(8, 8)
            fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
                let x = global_id.x;
                let y = global_id.y;
                
                if (x >= uniforms.width || y >= uniforms.height) {
                    return;
                }

                let halfHeight = uniforms.height / 2u;
                let coords = vec2<i32>(i32(x), i32(y));
                let currentColor = textureLoad(inputTex, coords, 0);
                
                var newColor: vec4<f32> = currentColor;

                var totalPixels = 0u;
                var newColor_r = newColor.r;
                var newColor_g = newColor.g;
                var newColor_b = newColor.b;
                // These two cannot be greater than 1
                let curColorMix = 0.5;
                let tmpColorMix = 0.5;
                let falloff = 0.005;

                if ( x >= 0 ) {
                    let lftCoords = vec2<i32>(i32(x) - 1, i32(y));
                    var tmpColor = textureLoad(inputTex, lftCoords, 0);
                    newColor_r = (newColor_r * curColorMix) + (tmpColor.r * tmpColorMix);
                    newColor_g = (newColor_g * curColorMix) + (tmpColor.g * tmpColorMix);
                    newColor_b = (newColor_b * curColorMix) + (tmpColor.b * tmpColorMix);
                    totalPixels++;
                }
                if ( x < uniforms.width && false ) {
                    let rgtCoords = vec2<i32>(i32(x) + 1, i32(y));
                    var tmpColor = textureLoad(inputTex, rgtCoords, 0);
                    newColor_r = (newColor_r * curColorMix) + (tmpColor.r * tmpColorMix);
                    newColor_g = (newColor_g * curColorMix) + (tmpColor.g * tmpColorMix);
                    newColor_b = (newColor_b * curColorMix) + (tmpColor.b * tmpColorMix);
                    totalPixels++;
                }
                if ( y > 0 ) {
                    let upCoords = vec2<i32>(i32(x), i32(y) - 1);
                    let tmpColor = textureLoad(inputTex, upCoords, 0);
                    newColor_r = (newColor_r * curColorMix) + (tmpColor.r * tmpColorMix);
                    newColor_g = (newColor_g * curColorMix) + (tmpColor.g * tmpColorMix);
                    newColor_b = (newColor_b * curColorMix) + (tmpColor.b * tmpColorMix);
                    totalPixels++;
                    if ( x > 0 ) {
                        let lftCoords = vec2<i32>(i32(x) - 1, i32(y) - 1);
                        var tmpColor = textureLoad(inputTex, lftCoords, 0);
                        newColor_r = (newColor_r * curColorMix) + (tmpColor.r * tmpColorMix);
                        newColor_g = (newColor_g * curColorMix) + (tmpColor.g * tmpColorMix);
                        newColor_b = (newColor_b * curColorMix) + (tmpColor.b * tmpColorMix);
                        totalPixels++;
                    }
                    if ( x < uniforms.width && false ) {
                        let rgtCoords = vec2<i32>(i32(x) + 1, i32(y) - 1);
                        var tmpColor = textureLoad(inputTex, rgtCoords, 0);
                        newColor_r = (newColor_r * curColorMix) + (tmpColor.r * tmpColorMix);
                        newColor_g = (newColor_g * curColorMix) + (tmpColor.g * tmpColorMix);
                        newColor_b = (newColor_b * curColorMix) + (tmpColor.b * tmpColorMix);
                        totalPixels++;
                    }
                }
                if ( y < uniforms.height ) {
                    let dnCoords = vec2<i32>(i32(x), i32(y) + 1);
                    let tmpColor = textureLoad(inputTex, dnCoords, 0);
                    newColor_r = (newColor_r * curColorMix) + (tmpColor.r * tmpColorMix);
                    newColor_g = (newColor_g * curColorMix) + (tmpColor.g * tmpColorMix);
                    newColor_b = (newColor_b * curColorMix) + (tmpColor.b * tmpColorMix);
                    totalPixels++;
                    if ( x > 0 ) {
                        let lftCoords = vec2<i32>(i32(x) - 1, i32(y) + 1);
                        var tmpColor = textureLoad(inputTex, lftCoords, 0);
                        newColor_r = (newColor_r * curColorMix) + (tmpColor.r * tmpColorMix);
                        newColor_g = (newColor_g * curColorMix) + (tmpColor.g * tmpColorMix);
                        newColor_b = (newColor_b * curColorMix) + (tmpColor.b * tmpColorMix);
                        totalPixels++;
                    }
                    if ( x < uniforms.width && false) {
                        let rgtCoords = vec2<i32>(i32(x) + 1, i32(y) + 1);
                        var tmpColor = textureLoad(inputTex, rgtCoords, 0);
                        newColor_r = (newColor_r * curColorMix) + (tmpColor.r * tmpColorMix);
                        newColor_g = (newColor_g * curColorMix) + (tmpColor.g * tmpColorMix);
                        newColor_b = (newColor_b * curColorMix) + (tmpColor.b * tmpColorMix);
                        totalPixels++;
                    }                        
                }
                if ( uniforms.clearFrame == 1u ) {
                    newColor = vec4<f32>(
                        max(newColor_r - falloff, 0.0),
                        max(newColor_g - falloff, 0.0),
                        max(newColor_b - falloff, 0.0),
                        1.0
                    );
                } else {
                    newColor = vec4<f32>(
                        max(newColor_r, 0.0),
                        max(newColor_g, 0.0),
                        max(newColor_b, 0.0),
                        1.0
                    );
                }
            
                textureStore(outputTex, coords, newColor);
            }
        `;

        // Waveform vertex shader
        const waveformVertexShader = `
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
            }

            @group(0) @binding(0) var<storage, read> audioData: array<f32>;
            @group(0) @binding(1) var<uniform> uniforms: WaveUniforms;

            struct WaveUniforms {
                width: f32,
                height: f32,
                midY: f32,
                heightChunks: f32,
                bufferLength: u32,
                sliceWidth: f32,
                lineWidth: f32,
            }

            @vertex
            fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                var output: VertexOutput;
                
                // Each audio sample generates 6 vertices (2 triangles for a quad)
                let audioIndex = vertexIndex / 6u;
                let vertexInQuad = vertexIndex % 6u;
                
                if (audioIndex >= uniforms.bufferLength - 1u) {
                    output.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
                    return output;
                }
                
                // Get current and next audio values
                let value1 = audioData[audioIndex] - 128.0;
                let value2 = audioData[audioIndex + 1u] - 128.0;
                
                let x1 = f32(audioIndex) * uniforms.sliceWidth;
                let y1 = uniforms.midY + (value1 * uniforms.heightChunks);
                let x2 = f32(audioIndex + 1u) * uniforms.sliceWidth;
                let y2 = uniforms.midY + (value2 * uniforms.heightChunks);
                
                // Calculate perpendicular offset for line thickness
                let dx = x2 - x1;
                let dy = y2 - y1;
                let len = sqrt(dx * dx + dy * dy);
                var perpX = 0.0;
                var perpY = 0.0;
                if (len > 0.0) {
                    perpX = -dy / len * uniforms.lineWidth;
                    perpY = dx / len * uniforms.lineWidth;
                }
                
                // Generate quad vertices
                var x: f32;
                var y: f32;
                
                if (vertexInQuad == 0u) {
                    x = x1 + perpX;
                    y = y1 + perpY;
                } else if (vertexInQuad == 1u) {
                    x = x1 - perpX;
                    y = y1 - perpY;
                } else if (vertexInQuad == 2u) {
                    x = x2 + perpX;
                    y = y2 + perpY;
                } else if (vertexInQuad == 3u) {
                    x = x2 + perpX;
                    y = y2 + perpY;
                } else if (vertexInQuad == 4u) {
                    x = x1 - perpX;
                    y = y1 - perpY;
                } else {
                    x = x2 - perpX;
                    y = y2 - perpY;
                }
                
                // Convert to NDC
                let ndcX = (x / uniforms.width) * 2.0 - 1.0;
                let ndcY = 1.0 - (y / uniforms.height) * 2.0;
                
                output.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
                return output;
            }
        `;

        // Waveform fragment shader
        const waveformFragmentShader = `
            @group(0) @binding(2) var<uniform> color: vec4<f32>;

            @fragment
            fn main() -> @location(0) vec4<f32> {
                return color;
            }
        `;

        // Create compute pipeline for blur
        const blurModule = this.device.createShaderModule({ code: blurShader });
        this.blurPipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: blurModule,
                entryPoint: 'main'
            }
        });

        // Create render pipeline for waveform
        const waveformVertModule = this.device.createShaderModule({ code: waveformVertexShader });
        const waveformFragModule = this.device.createShaderModule({ code: waveformFragmentShader });
        
        this.waveformPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: waveformVertModule,
                entryPoint: 'main'
            },
            fragment: {
                module: waveformFragModule,
                entryPoint: 'main',
                targets: [{
                    format: 'rgba8unorm',
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        }
                    }
                }]
            },
            primitive: {
                topology: 'triangle-list'
            },
            multisample: {
                count: 4
            }
        });
    }

    resizeCanvas() {
        // Render at higher resolution and scale down for better quality
        this.canvas.width = this.canvas.clientWidth * this.scaleFactor;
        this.canvas.height = this.canvas.clientHeight * this.scaleFactor;
        
        // Clean up old resources
        if (this.renderTexture) this.renderTexture.destroy();
        if (this.tempTexture) this.tempTexture.destroy();
        if (this.msaaTexture) this.msaaTexture.destroy();
        if (this.waveformTexture) this.waveformTexture.destroy();
        if (this.uniformBuffer) this.uniformBuffer.destroy();
        if (this.audioDataBuffer) this.audioDataBuffer.destroy();
        if (this.colorUniformBuffer) this.colorUniformBuffer.destroy();
        
        // Create render textures for blur effect (ping-pong buffers)
        this.renderTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | 
                   GPUTextureUsage.STORAGE_BINDING | 
                   GPUTextureUsage.COPY_SRC |
                   GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT
        });

        this.tempTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | 
                   GPUTextureUsage.STORAGE_BINDING | 
                   GPUTextureUsage.COPY_SRC |
                   GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT
        });

        // Create separate texture for waveform rendering with MSAA
        this.waveformTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | 
                   GPUTextureUsage.RENDER_ATTACHMENT
        });

        // Create MSAA texture for antialiasing
        this.msaaTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            format: 'rgba8unorm',
            sampleCount: this.sampleCount,
            usage: GPUTextureUsage.RENDER_ATTACHMENT
        });

        // Create uniform buffer for compute shader
        this.uniformBuffer = this.device.createBuffer({
            size: 16, // 4 x u32
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Create audio data buffer
        this.audioDataBuffer = this.device.createBuffer({
            size: this.bufferLength * 4, // f32 array, the *4 converts from element count to byte size
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        // Create color uniform buffer
        this.colorUniformBuffer = this.device.createBuffer({
            size: 28, // width, height, midY, heightChunks, bufferLength, sliceWidth, lineWidth
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Create sampler for texture copying
        if (!this.copySampler) {
            this.copySampler = this.device.createSampler({
                magFilter: 'nearest',
                minFilter: 'nearest'
            });
        }
        
        // Clear the canvas
        const encoder = this.device.createCommandEncoder();
        const canvasTexture = this.gpuContext.getCurrentTexture();
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: canvasTexture.createView(),
                loadOp: 'clear',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp: 'store'
            }]
        });
        renderPass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    renderFrame(params) {
        const {
            clearFrame,
            updateWaveform,
            audioData,
            colorRGB,
            mid_y,
            heightChunks,
            sliceWidth
        } = params;

        const encoder = this.device.createCommandEncoder();
        const canvasTexture = this.gpuContext.getCurrentTexture();
        
        // Run blur compute shader
        {
            const uniformData = new Uint32Array([
                this.canvas.width,
                this.canvas.height,
                clearFrame,
            ]);
            this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

            const bindGroup = this.device.createBindGroup({
                layout: this.blurPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.renderTexture.createView() },
                    { binding: 1, resource: this.tempTexture.createView() },
                    { binding: 2, resource: { buffer: this.uniformBuffer } }
                ]
            });

            const passEncoder = encoder.beginComputePass();
            passEncoder.setPipeline(this.blurPipeline);
            passEncoder.setBindGroup(0, bindGroup);
            passEncoder.dispatchWorkgroups(
                Math.ceil(this.canvas.width / 8),
                Math.ceil(this.canvas.height / 8)
            );
            passEncoder.end();
        }

        // Draw waveform if needed
        if (updateWaveform && audioData) {
            // Upload audio data to GPU
            const audioDataFloat = new Float32Array(this.bufferLength);
            for (let i = 0; i < this.bufferLength; i++) {
                audioDataFloat[i] = audioData[i];
            }
            this.device.queue.writeBuffer(this.audioDataBuffer, 0, audioDataFloat);

            // Create waveform uniforms buffer
            const waveformColorBuffer = this.device.createBuffer({
                size: 16, // vec4<f32>
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
            const colorData = new Float32Array([
                colorRGB.r / 255, colorRGB.g / 255, colorRGB.b / 255, 1.0
            ]);
            this.device.queue.writeBuffer(waveformColorBuffer, 0, colorData);

            // Update waveform uniforms
            const waveformUniformsData = new Float32Array([
                this.canvas.width,
                this.canvas.height,
                mid_y,
                heightChunks,
                this.bufferLength,
                sliceWidth,
                1.0  // line width in pixels
            ]);
            this.device.queue.writeBuffer(this.colorUniformBuffer, 0, waveformUniformsData);

            // Create separate buffers for shadow pass
            const shadowUniformsBuffer = this.device.createBuffer({
                size: 28,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
            
            const shadowColorBuffer = this.device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
            
            // Shadow uniforms (thicker line)
            const shadowUniformsData = new Float32Array([
                this.canvas.width,
                this.canvas.height,
                mid_y,
                heightChunks,
                this.bufferLength,
                sliceWidth,
                3.0  // shadow line width
            ]);
            this.device.queue.writeBuffer(shadowUniformsBuffer, 0, shadowUniformsData);
            
            // Shadow color (black)
            const shadowColorData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
            this.device.queue.writeBuffer(shadowColorBuffer, 0, shadowColorData);

            // Draw waveform with shadow
            {
                const renderPass = encoder.beginRenderPass({
                    colorAttachments: [{
                        view: this.msaaTexture.createView(),
                        resolveTarget: this.waveformTexture.createView(),
                        loadOp: 'clear',
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                        storeOp: 'store'
                    }]
                });

                renderPass.setPipeline(this.waveformPipeline);
                
                // Draw shadow first
                const shadowBindGroup = this.device.createBindGroup({
                    layout: this.waveformPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: this.audioDataBuffer } },
                        { binding: 1, resource: { buffer: shadowUniformsBuffer } },
                        { binding: 2, resource: { buffer: shadowColorBuffer } }
                    ]
                });
                
                renderPass.setBindGroup(0, shadowBindGroup);
                renderPass.draw((this.bufferLength - 1) * 6);
                
                // Draw actual waveform on top
                const mainBindGroup = this.device.createBindGroup({
                    layout: this.waveformPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: this.audioDataBuffer } },
                        { binding: 1, resource: { buffer: this.colorUniformBuffer } },
                        { binding: 2, resource: { buffer: waveformColorBuffer } }
                    ]
                });
                
                renderPass.setBindGroup(0, mainBindGroup);
                renderPass.draw((this.bufferLength - 1) * 6);
                
                renderPass.end();
            }

            // Composite waveform over blurred background
            {
                const bindGroup = this.device.createBindGroup({
                    layout: this.compositePipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: this.waveformTexture.createView() },
                        { binding: 1, resource: this.copySampler }
                    ]
                });

                const renderPass = encoder.beginRenderPass({
                    colorAttachments: [{
                        view: this.tempTexture.createView(),
                        loadOp: 'load',
                        storeOp: 'store'
                    }]
                });

                renderPass.setPipeline(this.compositePipeline);
                renderPass.setBindGroup(0, bindGroup);
                renderPass.draw(6);
                renderPass.end();
            }
        }

        // Copy final result to canvas texture
        {
            const bindGroup = this.device.createBindGroup({
                layout: this.copyPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.tempTexture.createView() },
                    { binding: 1, resource: this.copySampler }
                ]
            });

            const renderPass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: canvasTexture.createView(),
                    loadOp: 'load',
                    storeOp: 'store'
                }]
            });

            renderPass.setPipeline(this.copyPipeline);
            renderPass.setBindGroup(0, bindGroup);
            renderPass.draw(6);
            renderPass.end();
        }

        // Copy tempTexture back to renderTexture for next frame
        encoder.copyTextureToTexture(
            { texture: this.tempTexture },
            { texture: this.renderTexture },
            [this.canvas.width, this.canvas.height]
        );

        this.device.queue.submit([encoder.finish()]);
    }
}
