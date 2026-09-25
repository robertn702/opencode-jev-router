FROM python:3.11-bookworm
RUN pip install --no-cache-dir 'pytest<9' 'pluggy<2' 'setuptools<81' 'flask<4' 'django<6' 'sphinx<9' sympy scikit-learn tox
# No benchmark source, gold patch, grader, host home or shared /tmp in this image.
