cmake_minimum_required(VERSION 3.24)
if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
  set(CMAKE_CUDA_ARCHITECTURES 120)   # RTX 5060 Ti (Blackwell, sm_120); must be set before project()
endif()
project(gpu_ocr LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 20)

find_package(CUDAToolkit REQUIRED)

add_executable(gpu-ocr src/main.cpp src/assemble.cpp src/match.cu)
target_link_libraries(gpu-ocr PRIVATE CUDA::cudart)
target_include_directories(gpu-ocr PRIVATE ${CUDAToolkit_INCLUDE_DIRS})
target_compile_options(gpu-ocr PRIVATE
  $<$<COMPILE_LANG_AND_ID:CXX,MSVC>:/utf-8>
  $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler=/utf-8>)
