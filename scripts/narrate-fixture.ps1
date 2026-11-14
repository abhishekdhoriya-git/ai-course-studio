param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [Parameter(Mandatory = $true)][string]$OutputFile,
  [Parameter(Mandatory = $true)][string]$BoundaryFile
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Speech
Add-Type -ReferencedAssemblies System.Speech, System.Core -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Linq;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;

public sealed class FixtureWord {
    public string text { get; set; }
    public double startMs { get; set; }
    public int characterPosition { get; set; }
    public int characterCount { get; set; }
}
public sealed class FixtureSpeech {
    public string voice { get; set; }
    public string text { get; set; }
    public List<FixtureWord> boundaries { get; set; }
}
public static class FixtureNarrator {
    public static FixtureSpeech Render(string text, string path) {
        var result = new FixtureSpeech { text = text, boundaries = new List<FixtureWord>() };
        using (var synth = new SpeechSynthesizer()) {
            var installed = synth.GetInstalledVoices().Where(v => v.Enabled &&
                v.VoiceInfo.Culture.TwoLetterISOLanguageName == "en")
                .OrderBy(v => v.VoiceInfo.Name).FirstOrDefault();
            if (installed == null) throw new InvalidOperationException("No local English synthetic voice is installed.");
            synth.SelectVoice(installed.VoiceInfo.Name);
            result.voice = installed.VoiceInfo.Name;
            synth.Rate = 0;
            synth.Volume = 100;
            synth.SpeakProgress += (sender, e) => {
                lock (result.boundaries) {
                    result.boundaries.Add(new FixtureWord {
                        text = e.Text, startMs = e.AudioPosition.TotalMilliseconds,
                        characterPosition = e.CharacterPosition, characterCount = e.CharacterCount
                    });
                }
            };
            synth.SetOutputToWaveFile(path, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            synth.Speak(text);
            synth.SetOutputToNull();
        }
        if (result.boundaries.Count == 0) throw new InvalidOperationException("The local speech engine returned no measured word boundaries.");
        return result;
    }
}
'@
$text = [System.IO.File]::ReadAllText($InputFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw "The fixture script is empty." }
$result = [FixtureNarrator]::Render($text, $OutputFile)
$json = $result | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($BoundaryFile, $json, (New-Object System.Text.UTF8Encoding($false)))
