# Using the local studio

## Review the generated fixture

Open **http://127.0.0.1:4317** and choose **Review desk**.
Select the latest `fixture:output` version in **Artifact & version**, then play
the video. A previously selected historical version stays historical; select
the latest output to see a new render.

The animated fixture reveals headings and points, introduces approval cards in
narration order, draws dependency connections and builds the three-to-four
work-item example. Motion follows measured speech events; captions and the
non-cloned disclosure have their own safe areas.

Use **Clean MP4** for a master without burned-in captions, **Captioned MP4** for
captions embedded in the image, or download **SRT**, **VTT** and the **Final
transcript** separately. Approve the exact output version at `fixture-review`
only after watching it. A technical check or a test-harness input decision is
not your final approval.

## Reopen the existing engineering demonstration

From this repository's isolated working directory:

```powershell
$env:STUDIO_DATA = ".studio\verification"
npm start
```

This opens the existing engineering verification dataset. Its banner clearly
identifies simulated input approvals. It is not your real course workspace.
If the server is already running on port 4317, use that existing instance
instead of starting another.

After installing a changed animation template, choose **Update fixture
animations**. That creates a new style version; it does not copy an old style
approval. Review the current style, curriculum, lesson and storyboard gates,
then select **Render approved fixture**. The resulting output again needs
final human review. Rendering code and recipe hashes participate in the cache:
updating animation code cannot silently return an old static MP4.

## Try a script correction

1. Select the relevant `fixture:scene:...` artifact, then **Edit typed manifest**.
   Change its `script` and save a new version.
2. Review and approve the new `fixture:storyboard` version. Renew any other gate
   the review desk marks as needing review, then render the current fixture.
3. Watch the latest `fixture:output`, review its captions and timing, and decide
   on that exact version. Unchanged scene audio remains reusable.

Keep the four original scene layouts for this engineering fixture. A different
B-roll asset, layout, voice or pronunciation engine needs a corresponding
reviewed adapter; the fixture will not pretend to implement it.
**Map affected revision** records a targeted request and its impact; it does not
generate a replacement by itself.

## Start your first real course

To keep personal course inputs separate from the demonstration, stop the demo
server, clear its dataset setting, then start the normal local workspace:

```powershell
Remove-Item Env:STUDIO_DATA -ErrorAction SilentlyContinue
npm start
```

Choose **Course brief** and save your subject, audience, language, prerequisites
and learning outcomes. Also decide the first lesson's length, desired output
format, reference videos or original style, and pronunciation/teaching
preferences before pilot production. Do not put recordings or credentials in
the public repository.

The next production step is to research and draft one source-backed curriculum
and one lesson script/storyboard for your review. **Saving a brief does not yet
automatically research, author or render a real course**: the Copilot SDK
authoring integration and real voice/avatar providers are not connected in
this foundation. Workflows intentionally pause for those missing inputs.

Prove one approved lesson with a non-cloned presenter first. Provider selection,
data handling, identity enrollment and budget need separate explicit decisions
before a digital twin can be integrated. Course batching remains locked until
the required first real-presenter lesson and other production gates are
accepted. There is no automatic purchasing, identity upload or publishing.
