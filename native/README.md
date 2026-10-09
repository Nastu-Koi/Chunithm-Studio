# Local audio runtime

`AudioHelper.csproj` compiles the unmodified VGAudio library source with a small local JSON-reporting wrapper. The upstream source is pinned to commit `9d8f6ea04c83cccccb3dd7851a631bbd53a8dbbe` from https://github.com/Thealexbarney/VGAudio. Its MIT license is in `VGAudio/LICENSE` and copied into the Windows runtime directory.

Build for development:

```sh
dotnet build native/AudioHelper.csproj -c Release
dotnet native/bin/Release/net9.0/ChunithmAudio.dll encode input-48000hz-stereo-pcm16.wav output.hca
dotnet native/bin/Release/net9.0/ChunithmAudio.dll decode input.hca output.wav
dotnet native/bin/Release/net9.0/ChunithmAudio.dll decode-adx input.adx output.wav
```

Publish the self-contained Windows helper:

```sh
dotnet publish native/AudioHelper.csproj -c Release -r win-x64 --self-contained true -o native/win-x64
```

The desktop app includes `native/win-x64` as a unit. It requires no separately installed .NET runtime. `configureAudioRuntime({ nativeDirectory })` points to the parent `native` directory. Development on Linux uses the built .NET 9 DLL.

`native/win-x64/ffmpeg.exe` is the original 6.1.1 Windows executable distributed by the ffmpeg-static project at https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1. `FFmpeg.LICENSE` and `FFmpeg.README` accompany it; the latter identifies the upstream FFmpeg source revision and build configuration. This binary uses GPL v3. It is invoked as a separate local conversion process. Keep its license and source information with redistributed builds.

The self-contained .NET runtime license and notices are copied from the official Microsoft.NETCore.App.Runtime.win-x64 9.0.20 package into `DotNet.LICENSE` and `DotNet.THIRD-PARTY-NOTICES`.

Game songs, charts, covers, ACB and AWB containers are not bundled. Copied note textures and hit-sound WAV files live in `assets/game` and are included in the desktop program. The one-time sound importer resolves named cues, selects the default TAP instrument and headphone route, then uses VGAudio to decrypt ADX9 before decoding to PCM. Every decrypted frame is checked before writing output; the cache version prevents reuse of earlier undeciphered conversions. The documented ADX profile is corroborated by [vgmstream's ADX key table](https://github.com/vgmstream/vgmstream/blob/master/src/meta/adx_keys.h).

At export time the app reads metadata templates from the selected local game installation and writes a separate OPT folder. ACB changes are performed by parsing and rebuilding UTF tables and AFS2 offsets; lengths, stream references, preview commands and the AWB MD5 are verified after writing. The supported music bank layout is a single streaming HCA waveform with `music` and `preview` cues. Unknown layouts fail explicitly.

The encoding profile is never printed in logs or process arguments. An exported package is reported as structurally verified, not as verified in the game. Existing-game decode and a synthetic tone encode/decode were exercised on Linux; final game loading and timing require the Windows game.
