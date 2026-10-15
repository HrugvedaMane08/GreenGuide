import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";

const API_URL = process.env.REACT_APP_API_URL || "http://localhost:5000";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  async function loginUser(event) {
    event.preventDefault();
    setSubmitting(true);

    try {
      const res = await fetch(`${API_URL}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (data.success) {
        alert("✅ Login successful! Redirecting to dashboard...");

        sessionStorage.setItem("userId", data.user.id);
        sessionStorage.setItem("userName", data.user.name);
        sessionStorage.setItem("email", data.user.email);

        navigate("/dashboard");
      } else if (res.status === 503) {
        alert("❌ The service is temporarily unavailable. Please try again shortly.");
      } else {
        // The API returns `error`, not `message` — reading the wrong field here
        // meant every real reason ("User not found") showed as the generic text.
        alert("❌ " + (data.error || "Login failed. Please try again."));
      }
    } catch (err) {
      console.error("Login request failed:", err);
      alert("❌ Could not reach the server. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#1b3b2f] flex justify-center items-center px-4">
      <div className="bg-white w-full max-w-[900px] flex flex-col md:flex-row rounded-[25px] overflow-hidden shadow-[0_10px_30px_rgba(0,0,0,0.3)]">
        {/* Left side - illustration */}
        <div className="flex-1 bg-[#e9f3ec] flex justify-center items-center p-6 md:p-8">
          <img
            src="https://i.pinimg.com/1200x/95/76/a4/9576a4ea2172b65c7e4d542526fda95c.jpg"
            alt="Login Illustration"
            className="w-full max-w-[350px]"
          />
        </div>

        {/* Right side - form */}
        <div className="flex-1 bg-[#214734] text-white p-8 md:p-[50px_40px] flex flex-col justify-center">
          <h2 className="mb-7 text-3xl font-semibold">Login</h2>

          <form onSubmit={loginUser}>
            <div className="mb-5">
              <label
                htmlFor="email"
                className="block text-sm mb-1.5 text-[#cde0d4]"
              >
                Email
              </label>
              <input
                type="text"
                id="email"
                placeholder="Enter your email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-3 rounded-full text-white bg-[#2d5a46] placeholder-[#aac6b7] outline-none focus:ring-2 focus:ring-[#6bcf9d]"
              />
            </div>

            <div className="mb-5">
              <label
                htmlFor="password"
                className="block text-sm mb-1.5 text-[#cde0d4]"
              >
                Password
              </label>
              <input
                type="password"
                id="password"
                placeholder="Enter your password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-3 rounded-full text-white bg-[#2d5a46] placeholder-[#aac6b7] outline-none focus:ring-2 focus:ring-[#6bcf9d]"
              />
            </div>

            <Link
              to="/forgot"
              className="block mb-5 text-right text-sm text-[#9dd6ba] hover:underline"
            >
              Forgot Password?
            </Link>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 text-base font-bold rounded-full bg-[#8fd0b4] text-[#1b3b2f] hover:bg-[#a5e1c9] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? "Logging in..." : "Login"}
            </button>
          </form>

          <div className="text-center mt-5 text-sm text-[#b9dfca]">
            Don't have an account?{" "}
            <Link to="/signup" className="text-[#9dd6ba] font-bold hover:underline">
              Register Now
            </Link>
          </div>

          <div className="text-center mt-4 text-xs text-[#89b8a0]">
            <a href="#" className="hover:underline">
              Terms and Services
            </a>
          </div>

          <div className="text-center mt-2.5 text-xs text-[#89b8a0]">
            Have a problem? Contact us at{" "}
            <a href="mailto:support@example.com" className="text-[#9dd6ba] hover:underline">
              support@example.com
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}