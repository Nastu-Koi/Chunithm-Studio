using System;
using System.IO;
using System.Text.Json;
using VGAudio.Containers.Hca;
using VGAudio.Containers.Wave;
using VGAudio.Containers.Adx;
using VGAudio.Codecs.CriHca;
using VGAudio.Codecs.CriAdx;
using VGAudio.Formats.CriAdx;
using VGAudio.Formats.Pcm16;

// The encoding profile is kept inside the local helper, never echoed in command lines or logs.
// VGAudio is included from its public MIT-licensed source; see VGAudio/LICENSE.
internal static class Program
{
    private static CriHcaKey ProfileKey => new CriHcaKey(0x0074ff1fce264700UL);

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3 || (args[0] != "encode" && args[0] != "decode" && args[0] != "decode-adx"))
                throw new ArgumentException("Usage: ChunithmAudio encode|decode|decode-adx input output");
            var input = File.ReadAllBytes(args[1]);
            if (args[0] == "encode")
            {
                var audio = new WaveReader().Read(input);
                var pcm = audio.GetFormat<Pcm16Format>();
                if (pcm.SampleRate != 48000 || pcm.ChannelCount != 2)
                    throw new InvalidDataException("Expected stereo PCM WAV at 48000 Hz.");
                var writer = new HcaWriter { Configuration = new HcaConfiguration { EncryptionKey = ProfileKey, Quality = CriHcaQuality.Highest } };
                var encoded = writer.GetFile(audio);
                var check = new HcaReader { EncryptionKey = ProfileKey }.Read(encoded).GetFormat<Pcm16Format>();
                if (check.SampleRate != pcm.SampleRate || check.SampleCount != pcm.SampleCount || check.ChannelCount != pcm.ChannelCount)
                    throw new InvalidDataException("HCA decode verification did not preserve audio dimensions.");
                File.WriteAllBytes(args[2], encoded);
                Console.WriteLine(JsonSerializer.Serialize(new { sampleRate = pcm.SampleRate, channels = pcm.ChannelCount, sampleCount = pcm.SampleCount, duration = (double)pcm.SampleCount / pcm.SampleRate, verified = true }));
            }
            else if (args[0] == "decode-adx")
            {
                if (input.Length < 0x14 || input[0] != 0x80 || input[1] != 0)
                    throw new InvalidDataException("Expected an ADX file.");
                int revision = input[0x13];
                if (revision != 0 && revision != 9)
                    throw new InvalidDataException("Unsupported ADX encryption revision.");
                // The installed CHUNITHM NEW ADX9 profile is documented in
                // https://github.com/vgmstream/vgmstream/blob/master/src/meta/adx_keys.h
                // Its key code matches the existing local HCA profile. No guessing or logging.
                var reader = new AdxReader { EncryptionKey = revision == 9 ? new CriAdxKey(ProfileKey.KeyCode) : null };
                var audio = reader.Read(input);
                var adpcm = audio.GetFormat<CriAdxFormat>();
                int verifiedFrames = 0;
                if (revision == 9)
                {
                    foreach (var channel in adpcm.Channels)
                    {
                        for (int offset = 0; offset < channel.Audio.Length; offset += adpcm.FrameSize)
                        {
                            // ADX9 encoders leave bit 12 of each decrypted scale clear.
                            // Check every frame before producing PCM, rejecting a mismatched profile.
                            if ((channel.Audio[offset] & 0x10) != 0)
                                throw new InvalidDataException("ADX9 decrypted scale validation failed.");
                            verifiedFrames++;
                        }
                    }
                }
                var pcm = audio.GetFormat<Pcm16Format>();
                File.WriteAllBytes(args[2], new WaveWriter().GetFile(audio));
                Console.WriteLine(JsonSerializer.Serialize(new { sampleRate = pcm.SampleRate, channels = pcm.ChannelCount, sampleCount = pcm.SampleCount, duration = (double)pcm.SampleCount / pcm.SampleRate, adxRevision = revision, scaleFramesVerified = verifiedFrames }));
            }
            else
            {
                var audio = new HcaReader { EncryptionKey = ProfileKey }.Read(input);
                var pcm = audio.GetFormat<Pcm16Format>();
                File.WriteAllBytes(args[2], new WaveWriter().GetFile(audio));
                Console.WriteLine(JsonSerializer.Serialize(new { sampleRate = pcm.SampleRate, channels = pcm.ChannelCount, sampleCount = pcm.SampleCount, duration = (double)pcm.SampleCount / pcm.SampleRate }));
            }
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.GetType().Name + ": " + e.Message);
            return 1;
        }
    }
}
