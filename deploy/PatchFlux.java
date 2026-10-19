// Diagnostic-only compatibility patch for GroIMP 2.2 / GPUFlux 2.1.6.
// The upstream regex accepts an empty line number in modern NVIDIA build logs.
// Require at least one digit so warnings/errors reach the console unchanged.
import java.nio.file.Files;
import java.nio.file.Path;
public class PatchFlux {
    public static void main(String[] args) throws Exception {
        Path path = Path.of(args[0]);
        String text = Files.readString(path);
        String patched = text.replace("\\\\d*", "\\\\d+");
        if (patched.equals(text)) throw new IllegalStateException("GPUFlux source changed");
        Files.writeString(path, patched);
    }
}
